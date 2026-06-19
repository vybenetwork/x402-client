// Pay-per-call HTTP. Wraps @x402/fetch + @x402/core's signer registry,
// caches API discovery, applies budget, decodes receipt, throws typed errors.

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import type { ApiInfo, PaymentReceipt, Wallet } from "./types.js";
import {
  ApiError,
  NetworkError,
  PaymentRequiredError,
  UntrustedPaymentError,
  UNTRUSTED_PAYMENT_TAG_RE,
} from "./errors.js";
import { discoverApi, predictPriceUsd } from "./internal/discovery.js";
import { getSigner } from "./wallet.js";
import type { BudgetTracker } from "./budget.js";

// USDC on Solana has 6 decimals. The API settles in USDC; this constant
// converts the atomic-units `amount` on a 402 challenge into human USD. If
// the API ever switches to a different asset, the discovery contract
// would need to expose the asset's decimals and the policy below would
// need to look it up instead of hardcoding.
const USDC_DECIMALS = 6;
const USDC_ATOMIC_PER_USD = 10 ** USDC_DECIMALS;

export interface HttpClientCtx {
  wallet: Wallet;
  apiUrl: string;
  budget?: BudgetTracker;
  /**
   * Optional Solana RPC URL passed to `ExactSvmScheme` for blockhash /
   * simulation calls during payment signing. See VybeClientOptions.rpcUrl.
   */
  rpcUrl?: string;
  /**
   * Per-call hard cap on USD. Any 402 challenge demanding more is refused
   * before signing with {@link UntrustedPaymentError}. See VybeClientOptions.
   */
  maxUsdPerCall: number;
}

export interface PaidResponse<T = unknown> {
  data: T;
  receipt: PaymentReceipt | null;
  status: number;
}

interface Ready {
  fetcher: typeof globalThis.fetch;
  info: ApiInfo;
  apiUrl: string;
}

// Cache keyed by (wallet, apiUrl). Same wallet across prod+staging gets
// distinct entries — otherwise the second client would silently reuse the
// first's network/pricing context.
let _readyByClient: WeakMap<Wallet, Map<string, Ready>> | undefined;

async function ensureReady(ctx: HttpClientCtx): Promise<Ready> {
  if (!_readyByClient) _readyByClient = new WeakMap();
  // Cache key includes rpcUrl so a client that overrides the RPC mid-life
  // doesn't silently reuse a cached fetcher built with the previous one.
  const key = `${ctx.apiUrl}|${ctx.rpcUrl ?? ""}`;
  let perUrl = _readyByClient.get(ctx.wallet);
  if (perUrl) {
    const cached = perUrl.get(key);
    if (cached) return cached;
  } else {
    perUrl = new Map();
    _readyByClient.set(ctx.wallet, perUrl);
  }

  const info = await discoverApi(ctx.apiUrl);
  const signer = getSigner(ctx.wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheme = new ExactSvmScheme(
    signer as any,
    ctx.rpcUrl ? { rpcUrl: ctx.rpcUrl } : undefined,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x402 = new x402Client().register(info.network as any, scheme);

  // Trust boundary. The signer above will sign whatever requirements x402
  // hands it. Without a policy, a hostile or misconfigured API can
  // demand any amount to any address — the SDK would happily sign.
  //
  // The policy validates each 402 requirement against the discovered
  // identity (cached above) and the per-call USD cap. Anything that
  // doesn't pass throws immediately, before the scheme ever sees the
  // requirement. Discovery is itself trusted (same origin); the policy
  // primarily defends against (a) a 402 injected between requests after
  // a valid discovery, (b) API misconfiguration, and (c) silent
  // pricing drift past the user's per-call cap.
  x402.registerPolicy(buildTrustPolicy(info, ctx.maxUsdPerCall));

  const fetcher = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), x402);

  const ready: Ready = { fetcher, info, apiUrl: ctx.apiUrl };
  perUrl.set(key, ready);
  return ready;
}

/**
 * Reset the discovery cache for a wallet. Mainly for tests; production code
 * holds the cache for the life of the process.
 */
export function _resetReady(wallet: Wallet): void {
  _readyByClient?.delete(wallet);
}

/**
 * Build the x402 payment policy that vets each 402 challenge against the
 * discovered identity and the per-call USD cap. Throws
 * {@link UntrustedPaymentError} on any mismatch, *before* signing.
 *
 * Exported under `_` prefix for tests; not part of the public API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTrustPolicy(
  info: ApiInfo,
  maxUsdPerCall: number,
): (version: number, reqs: any[]) => any[] {
  if (!(maxUsdPerCall > 0) || !Number.isFinite(maxUsdPerCall)) {
    throw new TypeError(
      `buildTrustPolicy: maxUsdPerCall must be a positive finite number, got ${maxUsdPerCall}`,
    );
  }
  const maxAtomic = BigInt(Math.floor(maxUsdPerCall * USDC_ATOMIC_PER_USD));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_version: number, reqs: any[]) => {
    for (const r of reqs) {
      if (r.payTo !== info.payTo) {
        throw new UntrustedPaymentError(
          "payTo_mismatch",
          `402 challenge demanded payment to ${r.payTo} but discovery pinned ${info.payTo}`,
        );
      }
      if (r.network !== info.network) {
        throw new UntrustedPaymentError(
          "network_mismatch",
          `402 challenge demanded payment on network ${r.network} but discovery pinned ${info.network}`,
        );
      }
      let atomic: bigint;
      try {
        atomic = BigInt(r.amount);
      } catch {
        throw new UntrustedPaymentError(
          "amount_exceeds_per_call_cap",
          `402 challenge amount is not a valid integer: ${JSON.stringify(r.amount)}`,
        );
      }
      if (atomic < 0n) {
        throw new UntrustedPaymentError(
          "amount_exceeds_per_call_cap",
          `402 challenge amount must be non-negative: ${JSON.stringify(r.amount)}`,
        );
      }
      if (atomic > maxAtomic) {
        const usd = Number(atomic) / USDC_ATOMIC_PER_USD;
        throw new UntrustedPaymentError(
          "amount_exceeds_per_call_cap",
          `402 challenge demanded $${usd.toFixed(4)} which exceeds maxUsdPerCall ($${maxUsdPerCall.toFixed(4)})`,
        );
      }
    }
    return reqs;
  };
}

function decodeReceipt(res: Response): PaymentReceipt | null {
  const header = res.headers.get("payment-response");
  if (!header) return null;
  try {
    const decoded = JSON.parse(
      typeof Buffer !== "undefined"
        ? Buffer.from(header, "base64").toString("utf8")
        : atob(header),
    ) as PaymentReceipt;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Read the response body. For JSON content-type, parse strictly and throw
 * NetworkError on parse failure when the response is 2xx (we promised
 * "returns parsed body on 2xx"). On error responses, fall back to the raw
 * text so the caller can include it in ApiError without losing context.
 */
async function readResponseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return res.text();

  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    if (res.ok) {
      throw new NetworkError(
        `API returned status ${res.status} but body was not valid JSON: ${text.slice(0, 200)}`,
        err,
      );
    }
    return text;
  }
}

/**
 * Resolve a path argument to an absolute URL. Accepts:
 *   - "/v4/tokens/X" → joined with apiUrl
 *   - "https://<same-origin-as-apiUrl>/..." → used as-is (origin must match)
 *
 * Cross-origin absolute URLs are rejected because pricing/discovery, the
 * x402 signer's network registration, and the budget tracker are all
 * derived from `ctx.apiUrl` — letting a request fly to another origin
 * would sign and bill against the wrong network/payee. Throws TypeError
 * on relative paths without a leading "/" or on cross-origin absolute URLs.
 */
function resolveUrl(path: string, apiUrl: string): string {
  if (/^https?:\/\//i.test(path)) {
    let parsed: URL;
    try {
      parsed = new URL(path);
    } catch {
      throw new TypeError(
        `paidRequest: invalid absolute URL: ${JSON.stringify(path)}`,
      );
    }
    const base = new URL(apiUrl);
    if (parsed.origin !== base.origin) {
      throw new TypeError(
        `paidRequest: absolute URL origin ${JSON.stringify(parsed.origin)} does not match the configured apiUrl origin ${JSON.stringify(base.origin)}`,
      );
    }
    return parsed.toString();
  }
  if (!path.startsWith("/")) {
    throw new TypeError(
      `paidRequest: path must start with "/" or be an absolute http(s) URL on the configured origin, got: ${JSON.stringify(path)}`,
    );
  }
  return new URL(path, apiUrl).toString();
}

function describeApiErrorBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return `: ${err}`;
    if (err !== undefined) return `: ${JSON.stringify(err)}`;
  }
  // Plain-string bodies (e.g. API "Json deserialize error: missing
  // field 'X'" from the Vybe API). Truncate so a giant HTML error page
  // doesn't blow up the message.
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.length === 0) return "";
    return `: ${trimmed.length > 300 ? trimmed.slice(0, 300) + "…" : trimmed}`;
  }
  return "";
}

/**
 * Paid HTTP request. Auto-handles 402 (signs USDC transfer + retries),
 * decodes the payment receipt header on success, applies the budget tracker,
 * and maps non-2xx responses to typed errors.
 */
export async function paidRequest<T = unknown>(
  ctx: HttpClientCtx,
  path: string,
  init?: RequestInit,
): Promise<PaidResponse<T>> {
  const ready = await ensureReady(ctx);

  // Reserve the predicted price atomically so concurrent paidRequest
  // calls can't both pass a separate check() before either commits.
  // Throws BudgetExceededError immediately on overflow (reject mode).
  const expected = predictPriceUsd(path, ready.info);
  const reserved = ctx.budget?.reserve(expected);

  const url = resolveUrl(path, ctx.apiUrl);
  let res: Response;
  try {
    res = await ready.fetcher(url, init);
  } catch (err) {
    // Transport-level failure — nothing was billed, refund the reservation.
    if (reserved !== undefined) ctx.budget?.refund(reserved);
    // The trust policy (registered above) throws UntrustedPaymentError
    // synchronously from inside the x402 client when a 402 challenge
    // doesn't pass. `@x402/fetch` then re-throws as a plain Error during
    // its "create payment payload" step, preserving only the message —
    // not the class or `.cause`. We embed a `[VYBE_TRUST:<reason>]` tag
    // in the error's message specifically so it can be parsed back here
    // and re-surfaced with the original type. See UntrustedPaymentError.
    if (err instanceof UntrustedPaymentError) throw err;
    if (err instanceof Error) {
      const m = UNTRUSTED_PAYMENT_TAG_RE.exec(err.message);
      if (m) {
        const reason = m[1] as
          | "payTo_mismatch"
          | "network_mismatch"
          | "amount_exceeds_per_call_cap";
        const detail = m[2] ?? "";
        throw new UntrustedPaymentError(reason, detail);
      }
    }
    throw new NetworkError(`request to ${url} failed`, err);
  }

  const receipt = decodeReceipt(res);
  // Reconcile against the actual amount the API billed (receipt header)
  // instead of the cached prediction. Discovery is cached for the life
  // of the process, so a price change mid-session would otherwise let
  // budgetState() drift from real spend.
  const billed =
    typeof receipt?.amount === "number" && Number.isFinite(receipt.amount)
      ? receipt.amount
      : expected;

  if (res.ok) {
    // 2xx — API charged us per pay-on-success policy.
    if (reserved !== undefined) ctx.budget?.commit(reserved, billed);
    return {
      data: (await readResponseBody(res)) as T,
      receipt,
      status: res.status,
    };
  }

  // Body-read on the error path. If the response stream errors out
  // mid-body (rare — connection drops), the reservation would otherwise
  // be leaked: never committed, never refunded. Treat unreadable 5xx
  // bodies as refundable; 4xx commits (the API confirmed it billed,
  // we just can't see what it said).
  let body: unknown;
  try {
    body = await readResponseBody(res);
  } catch (err) {
    if (reserved !== undefined) {
      if (res.status >= 500) ctx.budget?.refund(reserved);
      else ctx.budget?.commit(reserved, billed);
    }
    throw new NetworkError(
      `failed to read response body for status ${res.status}`,
      err,
    );
  }

  if (res.status === 402) {
    // Verification failed — no on-chain charge, refund the reservation.
    if (reserved !== undefined) ctx.budget?.refund(reserved);
    const reason =
      body &&
      typeof body === "object" &&
      "reason" in body &&
      typeof (body as Record<string, unknown>).reason === "string"
        ? ((body as Record<string, unknown>).reason as string)
        : "payment verification failed";
    throw new PaymentRequiredError(
      reason,
      expected,
      ready.info.payTo,
      ready.info.network,
    );
  }

  // 4xx (not 402): API charged us per pay-on-success (user-error responses
  // still bill — bad input is on the user). Adjust to the receipt amount.
  // 5xx: API abandoned the payment, no charge — refund.
  const refunded = res.status >= 500;
  if (reserved !== undefined) {
    if (refunded) ctx.budget?.refund(reserved);
    else ctx.budget?.commit(reserved, billed);
  }
  throw new ApiError(
    `API returned ${res.status}${describeApiErrorBody(body)}`,
    res.status,
    refunded,
    refunded ? 0 : billed,
  );
}
