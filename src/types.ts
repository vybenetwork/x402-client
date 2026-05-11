// Public type surface for the SDK.

export interface VybeClientOptions {
  /**
   * Solana keypair signer that will pay for calls. Use {@link loadKeypair}
   * to construct one from a base64 string, file, or env var.
   */
  wallet: Wallet;

  /**
   * Override the default Vybe API endpoint. Only needed when running
   * against a non-production deployment (staging, local self-host, etc.).
   * Default points to the production deployment.
   */
  apiUrl?: string;

  /**
   * Cumulative-spend cap. The SDK tracks USD spent across all paid calls in
   * this client instance. When the next call would push spending over
   * `maxUsd`, the SDK either rejects with {@link BudgetExceededError} or
   * emits a warning, depending on `onExceed`.
   */
  budget?: {
    maxUsd: number;
    onExceed?: "reject" | "warn"; // default "reject"
  };

  /**
   * Per-call hard cap on USD spend. The SDK refuses to sign any 402 challenge
   * demanding more than this amount, throwing {@link UntrustedPaymentError}
   * *before* the signature is produced (no funds at risk).
   *
   * This is a defense against (a) API misconfiguration, (b) a malicious
   * 402 response injected mid-session, or (c) unexpected price changes. It
   * complements `budget.maxUsd` (cumulative cap) — `maxUsdPerCall` bounds a
   * single transfer, `budget.maxUsd` bounds the total.
   *
   * Default: $0.10 — 10× the highest known endpoint price ($0.010 per batch
   * POST). Raise it if you've audited a higher-priced endpoint; lower it
   * for tighter control.
   */
  maxUsdPerCall?: number;

  /**
   * WebSocket sessions auto-topup when balance falls below this threshold.
   * Set to 0 to disable auto-topup. Default 50.
   */
  autotopupThreshold?: number;

  /**
   * Solana RPC URL used while signing x402 payment payloads (fetch latest
   * blockhash, simulate transactions). Defaults to whatever `@x402/svm`
   * chooses, currently the public mainnet RPC — which rate-limits at
   * roughly 5 requests per second and will surface as `NetworkError`s
   * with a `429: Too Many Requests` cause under any real concurrency.
   *
   * For non-trivial throughput, use a paid RPC tier (Helius, Triton,
   * QuickNode, etc.). The URL is used only by the SDK during signing.
   */
  rpcUrl?: string;
}

/**
 * Opaque wallet handle. Constructed via {@link loadKeypair}; the underlying
 * signer is held in a module-private registry so callers can only see the
 * public address.
 */
export interface Wallet {
  readonly address: string;
}

/**
 * Network identifier as published by the API's `/` discovery endpoint.
 * Format: `chain:genesis-hash`, e.g. `solana:5eykt...` (mainnet) or
 * `solana:EtWTR...` (devnet). Passed directly to x402's network registry.
 */
export type NetworkId = `${string}:${string}`;

/**
 * Discovery info pulled from `GET /` on first call. Cached per client
 * instance.
 */
export interface ApiInfo {
  network: NetworkId;
  payTo: string;
  defaultPriceUsd: number;
  pricing: Array<{ match: string; priceUsd: number }>;
}

/**
 * Receipt of an x402-paid HTTP call. Decoded from the `payment-response`
 * header on a successful 2xx/4xx response.
 */
export interface PaymentReceipt {
  txHash: string | "pending";
  payer: string;
  amount: number; // USD
  network: string;
  settlement: "sync" | "async";
}

/**
 * Single event from a WebSocket stream. `data` is the event payload the
 * API pushed; `balance` is your remaining credit count after this event.
 */
export interface StreamEvent<TData = unknown> {
  data: TData;
  balance: number;
  cost: number;
  warning?: "LOW_BALANCE" | "CREDITS_EXHAUSTED";
}

/**
 * Options for opening a stream.
 */
export interface StreamOptions {
  /** Vybe configure filters. Forwarded verbatim to the WS API. */
  filters: Record<string, unknown>;
  /**
   * Disable auto-topup for this stream. Defaults to the client-level
   * setting.
   */
  autoTopup?: boolean;
  /** Cancel the stream. */
  signal?: AbortSignal;
}
