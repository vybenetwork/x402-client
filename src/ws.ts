// WebSocket streaming. Buys a session, opens /ws, forwards the user's
// configure message, yields wrapped events via async iterator. Auto-tops up
// when balance falls below the configured threshold.

import WebSocket from "ws";

import type { StreamEvent, StreamOptions, Wallet } from "./types.js";
import {
  InsufficientCreditsError,
  NetworkError,
  ServiceUnavailableError,
  VybeError,
} from "./errors.js";
import { paidRequest } from "./http.js";
import type { BudgetTracker } from "./budget.js";
import { AsyncQueue } from "./internal/async-queue.js";

const SESSION_PATH = "/api/sessions";

export interface StreamContext {
  wallet: Wallet;
  apiUrl: string;
  autotopupThreshold: number;
  budget?: BudgetTracker;
  rpcUrl?: string;
  maxUsdPerCall: number;
}

export interface VybeStream<TData = unknown> extends AsyncIterable<StreamEvent<TData>> {
  /** Force-close the stream. */
  close(): void;
  /** Current credit balance (updated as events flow). */
  readonly balance: number;
  /** Session id assigned by the API. */
  readonly sessionId: string;
}

interface SessionResponse {
  sessionId: string;
  jwt: string;
  credits: number;
  expiresAt: string;
}

interface TopupResponse {
  creditsAdded: number;
  balance: number;
  alreadyProcessed: boolean;
  jwt: string;
  expiresAt: string;
}

interface ConnectedFrame {
  type: "connected";
  sessionId: string;
  balance: number;
  connectionCost: number;
}

interface EventFrame {
  data: unknown;
  credits: { balance: number; cost: number; warning?: "LOW_BALANCE" | "CREDITS_EXHAUSTED" };
}

function wsUrlFromApiUrl(apiUrl: string): string {
  // WS path is `/live`, mirroring Vybe's HTTP `/v4/*` routes on the same
  // host. WHATWG URL parser handles trailing slashes, sub-paths, and
  // explicit ports correctly.
  const u = new URL("/live", apiUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function mapCloseToError(code: number, reason: string, balance: number): VybeError | undefined {
  switch (code) {
    case 1000:
    case 1001:
      // Normal/going-away close — iterator ends cleanly with done:true.
      return undefined;
    case 4010:
      return new InsufficientCreditsError(balance);
    case 4503:
      return new ServiceUnavailableError();
    case 4001:
    case 4002:
    case 4008:
      return new VybeError(`WebSocket closed: ${reason || `code ${code}`}`);
    default:
      return new NetworkError(`WebSocket closed unexpectedly (code ${code}, reason: ${reason || "none"})`);
  }
}

class VybeStreamImpl<TData> implements VybeStream<TData> {
  private queue = new AsyncQueue<StreamEvent<TData>>();
  // Optional because an abort that fires between `openStream`'s pre-check
  // and the constructor running can leave us with no socket — shutdown()
  // tolerates that.
  private ws?: WebSocket;
  private toppingUp = false;
  private closed = false;

  constructor(
    private ctx: StreamContext,
    private session: SessionResponse,
    private opts: StreamOptions,
  ) {
    this._balance = session.credits;
    this._jwt = session.jwt;
    if (this.opts.signal?.aborted) {
      // Don't open a socket we'd immediately tear down.
      this.closed = true;
      this.queue.close(this.opts.signal.reason);
      return;
    }
    this.ws = this.openSocket();
  }

  private _balance: number;
  private _jwt: string;

  get balance(): number { return this._balance; }
  get sessionId(): string { return this.session.sessionId; }

  private openSocket(): WebSocket {
    const url = `${wsUrlFromApiUrl(this.ctx.apiUrl)}?jwt=${encodeURIComponent(this._jwt)}`;
    const ws = new WebSocket(url);

    ws.on("open", () => {
      // If close() / abort fired between socket creation and the open
      // event, don't bother sending configure — we're tearing down anyway.
      if (this.closed) return;
      try {
        // Forward the user's configure message verbatim. The API proxies it.
        ws.send(JSON.stringify({ type: "configure", filters: this.opts.filters }));
      } catch (err) {
        this.shutdown(new NetworkError(`failed to send configure: ${err instanceof Error ? err.message : "unknown"}`));
      }
    });

    ws.on("message", raw => this.onMessage(raw));

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString() ?? "";
      // Suppress close-error when the user explicitly called close() — we
      // already ended the queue cleanly.
      if (this.closed) return;
      this.shutdown(mapCloseToError(code, reason, this._balance));
    });

    ws.on("error", err => {
      // ws emits 'error' before 'close'. Save the message to enrich the close
      // error if we want; otherwise rely on the close handler.
      if (this.closed) return;
      this.shutdown(new NetworkError(`WebSocket error: ${err.message}`));
    });

    if (this.opts.signal) {
      const onAbort = () => this.close();
      if (this.opts.signal.aborted) onAbort();
      else this.opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    return ws;
  }

  private onMessage(raw: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      // Non-JSON frames are not expected from the API; ignore.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    // 'connected' frame on socket open — informational, not an event.
    if ((parsed as ConnectedFrame).type === "connected") {
      const c = parsed as ConnectedFrame;
      this._balance = c.balance;
      return;
    }

    // Event frame: { data, credits: { balance, cost, warning? } }. Drop
    // frames missing required numeric fields — `cost` is part of the public
    // StreamEvent contract, so we can't propagate undefined.
    const ev = parsed as EventFrame;
    if (
      !ev.credits
      || typeof ev.credits.balance !== "number"
      || typeof ev.credits.cost !== "number"
    ) return;

    this._balance = ev.credits.balance;
    this.queue.push({
      data: ev.data as TData,
      balance: ev.credits.balance,
      cost: ev.credits.cost,
      warning: ev.credits.warning,
    });

    this.maybeAutotopup();
  }

  private maybeAutotopup(): void {
    if (this.toppingUp || this.closed) return;
    if (this.opts.autoTopup === false) return;
    if (this.ctx.autotopupThreshold <= 0) return;
    if (this._balance >= this.ctx.autotopupThreshold) return;

    this.toppingUp = true;
    this.runTopup().finally(() => { this.toppingUp = false; });
  }

  private async runTopup(): Promise<void> {
    try {
      const idempotencyKey = `topup-${this.session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { data } = await paidRequest<TopupResponse>(
        {
          wallet: this.ctx.wallet,
          apiUrl: this.ctx.apiUrl,
          budget: this.ctx.budget,
          rpcUrl: this.ctx.rpcUrl,
          maxUsdPerCall: this.ctx.maxUsdPerCall,
        },
        `${SESSION_PATH}/${this.session.sessionId}/topup`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._jwt}`,
            "Idempotency-Key": idempotencyKey,
          },
        },
      );
      this._jwt = data.jwt;
      this._balance = data.balance;
    } catch {
      // Auto-topup failure isn't fatal: the stream continues until the API
      // closes with 4010 (InsufficientCreditsError), which is the contract
      // consumers can rely on. Don't synthesize a fake event into TData.
    }
  }

  private shutdown(err?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.queue.close(err);
  }

  close(): void {
    this.shutdown();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent<TData>> {
    // Wrap the queue's iterator so consumer-initiated termination (break in
    // for-await, throw, manual return()) also tears down the WebSocket.
    // Without this, the queue closes but the socket stays open.
    const inner = this.queue[Symbol.asyncIterator]();
    const stream = this;
    return {
      next: () => inner.next(),
      return: async (value?: unknown): Promise<IteratorResult<StreamEvent<TData>>> => {
        stream.shutdown();
        if (inner.return) await inner.return(value);
        return { value: undefined as never, done: true };
      },
      throw: async (err?: unknown): Promise<IteratorResult<StreamEvent<TData>>> => {
        stream.shutdown();
        if (inner.throw) return inner.throw(err);
        throw err;
      },
    };
  }
}

/**
 * Open a WebSocket stream. Pays $0.01 to mint a session, connects, sends the
 * user's configure message verbatim, yields events as they arrive wrapped
 * with credit metadata. Auto-tops up when balance falls below the configured
 * threshold (set the threshold to 0 or pass `autoTopup: false` to disable).
 */
export async function openStream<TData = unknown>(
  ctx: StreamContext,
  opts: StreamOptions,
): Promise<VybeStream<TData>> {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("openStream: opts is required");
  }
  if (!opts.filters || typeof opts.filters !== "object" || Array.isArray(opts.filters)) {
    throw new TypeError("openStream: opts.filters must be a plain object");
  }
  // Bail on already-aborted signals before paying. Otherwise the SDK would
  // mint a session and open a socket only to immediately close them.
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new VybeError("openStream: signal already aborted");
  }

  // paidRequest does its own budget check/charge based on discovered pricing.
  // No separate pre-check here — duplicating it with SESSION_PRICE_USD would
  // inconsistently account against a hardcoded value vs. the live price.
  const { data: session } = await paidRequest<SessionResponse>(
    {
      wallet: ctx.wallet,
      apiUrl: ctx.apiUrl,
      budget: ctx.budget,
      rpcUrl: ctx.rpcUrl,
      maxUsdPerCall: ctx.maxUsdPerCall,
    },
    SESSION_PATH,
    { method: "POST" },
  );
  // paidRequest already charged the budget on success; nothing else to do.

  return new VybeStreamImpl<TData>(ctx, session, opts);
}
