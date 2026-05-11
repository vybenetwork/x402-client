// Public entry: VybeClient.
// Composes wallet + budget + http + ws into one object.

import type {
  VybeClientOptions,
  StreamOptions,
  Wallet,
  PaymentReceipt,
} from "./types.js";
import { BudgetTracker } from "./budget.js";
import { paidRequest, type PaidResponse } from "./http.js";
import { openStream, type VybeStream } from "./ws.js";

const DEFAULT_API_URL = "https://x402-api.vybenetwork.xyz";
const DEFAULT_AUTOTOPUP_THRESHOLD = 50;
const DEFAULT_MAX_USD_PER_CALL = 0.10;

export class VybeClient {
  readonly apiUrl: string;
  readonly wallet: Wallet;
  readonly budget?: BudgetTracker;
  readonly autotopupThreshold: number;
  readonly rpcUrl?: string;
  readonly maxUsdPerCall: number;

  constructor(opts: VybeClientOptions) {
    this.wallet = opts.wallet;
    this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    this.autotopupThreshold = opts.autotopupThreshold ?? DEFAULT_AUTOTOPUP_THRESHOLD;
    this.rpcUrl = opts.rpcUrl;
    this.maxUsdPerCall = opts.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL;
    if (this.maxUsdPerCall <= 0 || !Number.isFinite(this.maxUsdPerCall)) {
      throw new TypeError(`VybeClient: maxUsdPerCall must be a positive finite number, got ${this.maxUsdPerCall}`);
    }
    if (opts.budget) {
      this.budget = new BudgetTracker(opts.budget.maxUsd, opts.budget.onExceed ?? "reject");
    }
  }

  /**
   * Issue a paid GET. Returns parsed body on 2xx; throws typed errors
   * otherwise (PaymentRequiredError, ApiError, NetworkError,
   * BudgetExceededError, ServiceUnavailableError).
   *
   * The method is forced to GET — any `init.method` is ignored. Use
   * `request()` for any other method.
   */
  async get<T = unknown>(path: string, init?: Omit<RequestInit, "method">): Promise<T> {
    const { data } = await this.request<T>(path, { ...init, method: "GET" });
    return data;
  }

  /**
   * Issue a paid request — covers all HTTP methods. Returns the structured
   * response including parsed body, decoded receipt, and status. Throws
   * typed errors on non-2xx.
   */
  async request<T = unknown>(path: string, init?: RequestInit): Promise<PaidResponse<T>> {
    return paidRequest<T>(
      {
        wallet: this.wallet,
        apiUrl: this.apiUrl,
        budget: this.budget,
        rpcUrl: this.rpcUrl,
        maxUsdPerCall: this.maxUsdPerCall,
      },
      path,
      init,
    );
  }

  /**
   * Open a WebSocket stream. Pays $0.01 to mint a session, connects, sends
   * the configure filters, yields events wrapped with credit metadata.
   * Auto-tops up when balance falls below the threshold (default 50, set 0
   * or pass `autoTopup: false` to disable).
   */
  async stream<TData = unknown>(opts: StreamOptions): Promise<VybeStream<TData>> {
    return openStream<TData>(
      {
        wallet: this.wallet,
        apiUrl: this.apiUrl,
        autotopupThreshold: this.autotopupThreshold,
        budget: this.budget,
        rpcUrl: this.rpcUrl,
        maxUsdPerCall: this.maxUsdPerCall,
      },
      opts,
    );
  }

  /** Inspect the current budget state, if any. */
  budgetState() {
    return this.budget?.state() ?? null;
  }
}

export type { PaidResponse, PaymentReceipt, VybeStream };
