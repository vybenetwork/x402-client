// Typed errors thrown by the SDK. Catch with instanceof.

export class VybeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "VybeError";
  }
}

export class NetworkError extends VybeError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NetworkError";
  }
}

export class PaymentRequiredError extends VybeError {
  constructor(
    message: string,
    public readonly amountUsd: number,
    public readonly payTo: string,
    public readonly network: string,
  ) {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

/**
 * Non-2xx response from the API. `refunded === true` when the API abandoned
 * the payment (no charge happened — typically 5xx). `refunded === false` when
 * the call was billed despite the error (typically 4xx user-error responses).
 *
 * `chargedUsd` carries the amount actually billed for this call, so callers
 * can report accurate spend even on failures (0 when refunded).
 */
export class ApiError extends VybeError {
  public readonly refunded: boolean;
  public readonly chargedUsd: number;
  constructor(
    message: string,
    public readonly status: number,
    refunded: boolean,
    chargedUsd: number,
  ) {
    super(message);
    this.refunded = refunded;
    this.chargedUsd = chargedUsd;
    this.name = "ApiError";
  }
}

/**
 * Vybe's API is unavailable; the service has closed your stream or refused
 * to open a new session. Retry after a backoff.
 */
export class ServiceUnavailableError extends VybeError {
  constructor(public readonly retryAfter?: number) {
    super("Vybe service is temporarily unavailable.");
    this.name = "ServiceUnavailableError";
  }
}

export class InsufficientCreditsError extends VybeError {
  constructor(public readonly balance: number) {
    super("Session out of credits; the API closed the WebSocket.");
    this.name = "InsufficientCreditsError";
  }
}

/**
 * The SDK refused to sign a payment because the 402 challenge from the
 * API didn't match the SDK's trust assumptions: the payee differs
 * from the discovered `payTo`, the network differs from the discovered
 * network, the SVM token mint is not Solana USDC, or the demanded
 * amount exceeds the configured per-call cap.
 *
 * This is a *defensive* error — it fires before any signature, so no
 * funds are at risk. It typically indicates one of: (a) the API
 * shipped a misconfigured response, (b) the API changed pricing
 * mid-session and the new amount exceeds your `maxUsdPerCall`, or
 * (c) a man-in-the-middle injected a hostile 402 between you and
 * the API.
 *
 * The most common legitimate cause is (b) — raise `maxUsdPerCall` if
 * you've audited the new pricing. Otherwise, treat as a security signal.
 */
export type UntrustedPaymentReason =
  | "payTo_mismatch"
  | "network_mismatch"
  | "asset_mismatch"
  | "amount_exceeds_per_call_cap";

/**
 * Sentinel tag embedded in `UntrustedPaymentError.message`. `@x402/fetch`
 * wraps policy throws as `new Error("Failed to create payment payload: " + msg)`
 * — only the message string survives the wrap, so we encode reason here
 * and parse it back in `paidRequest` to restore the typed error class.
 *
 * Internal — kept in lockstep with the regex on the consumer side.
 */
export const UNTRUSTED_PAYMENT_TAG_RE = /\[VYBE_TRUST:(payTo_mismatch|network_mismatch|asset_mismatch|amount_exceeds_per_call_cap)\]\s*(.*)/s;

export class UntrustedPaymentError extends VybeError {
  constructor(
    public readonly reason: UntrustedPaymentReason,
    detail: string,
  ) {
    // Prefix with the parseable tag so the typed error can be reconstructed
    // after @x402/fetch flattens us into a plain Error during its payload-
    // creation wrap.
    super(`[VYBE_TRUST:${reason}] ${detail}`);
    this.name = "UntrustedPaymentError";
  }
}

export class BudgetExceededError extends VybeError {
  constructor(
    public readonly attemptedUsd: number,
    public readonly capUsd: number,
    public readonly spentUsd: number,
  ) {
    super(`Call would push spend over the configured cap of $${capUsd.toFixed(3)} (already spent $${spentUsd.toFixed(3)}, attempted $${attemptedUsd.toFixed(3)}).`);
    this.name = "BudgetExceededError";
  }
}
