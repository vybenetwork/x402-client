// Public barrel.

export { VybeClient } from "./client.js";
export type { VybeStream } from "./client.js";
export { loadKeypair } from "./wallet.js";

export type {
  VybeClientOptions,
  Wallet,
  NetworkId,
  ApiInfo,
  PaymentReceipt,
  StreamEvent,
  StreamOptions,
} from "./types.js";

export {
  VybeError,
  NetworkError,
  PaymentRequiredError,
  ApiError,
  ServiceUnavailableError,
  InsufficientCreditsError,
  BudgetExceededError,
  UntrustedPaymentError,
} from "./errors.js";
