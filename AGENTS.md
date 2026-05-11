# Vybe x402 Client — Agent Instructions

> Machine-readable instructions for AI agents to make pay-per-call requests to Vybe's Solana analytics API via the x402 protocol.

## Quick Reference

| Requirement | Value |
|-------------|-------|
| Package | `@vybenetwork/x402-client` (npm; pre-release, pin a specific version while in beta) |
| Cost per call | $0.001–$0.010 USDC (depends on endpoint, see discovery) |
| Per-call safety cap | $0.10 USDC default (refuses to sign 402s above this; tune via `maxUsdPerCall`) |
| Network | Solana Mainnet |
| API URL | `https://x402-api.vybenetwork.xyz` (distinct from `api.vybenetwork.xyz`, which is the API-key subscription endpoint) |
| Discovery | `GET https://x402-api.vybenetwork.xyz/` (network, payTo, per-route pricing) |
| Vybe API reference | https://docs.vybenetwork.com/reference |

## Prerequisites

1. Node.js 20+ runtime. The SDK is also browser-compatible for HTTP (see README "Browser" section), but **do not run it in a browser with a raw private key** — `loadKeypair` takes the full keypair, which would be exposed to any user, extension, or DevTools tab with page access. Server-side Node is the realistic target today; production browser usage needs wallet-adapter signing (not yet supported).
2. A **dedicated** funded Solana wallet (do not reuse a wallet you also use for trading or other activity — the SDK signs USDC transfers per call, so mixed-purpose wallets create fragile bookkeeping and risk unintended charges):
   - **USDC** (mainnet, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) — pays per call. $0.50 covers ~500 default calls.
   - **SOL is NOT required** for the client wallet. The x402 API pays Solana gas on every transfer. The wallet only needs USDC and an associated USDC token account (created the first time anyone sends USDC to it).
3. A Solana RPC URL. The SDK signs each payment client-side, which makes 2 RPC calls per paid request (`fetchMint` + `getLatestBlockhash`).
   - Public mainnet RPC works for sequential demo use (~5 RPS ceiling).
   - For any concurrency, use a paid tier. [Helius](https://www.helius.dev/) free tier gives 10 RPS, no card.
   - Helius offers an agent-friendly CLI signup: see https://dashboard.helius.dev/agents.md — pays 1 USDC, returns an API key in JSON.

## Complete Flow

### Step 1: Install

```bash
npm install @vybenetwork/x402-client
```

### Step 2: Load Keypair

```ts
import { VybeClient, loadKeypair } from "@vybenetwork/x402-client";

const client = new VybeClient({
  wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),  // base58 (wallet "Export Private Key") OR base64 — auto-detected
  rpcUrl: process.env.SOLANA_RPC_URL,                          // strongly recommended
  budget: { maxUsd: 1.00, onExceed: "reject" },                // optional cumulative-spend cap
});
```

`loadKeypair` accepts a base58 string (most Solana wallets' "Export Private Key"), a base64 string, or — in Node — a file path via `loadKeypair.fromFile(path)`. The wallet's public address is exposed as `client.wallet.address`; private key never leaves the SDK.

### Step 3: Make a Paid Call

```ts
const tokenInfo = await client.get("/v4/tokens/<mintAddress>");
```

Method maps:
- `client.get(path)` — GET, parsed body returned.
- `client.request(path, init)` — any HTTP method (POST batch endpoints use `request` with `method: "POST"` and JSON body).

The SDK auto-handles the 402 challenge: first request returns 402 with payment requirements, SDK signs a USDC transfer matching those terms, retries with the signed payment header, returns the body. Single `await`.

### Step 4 (optional): Stream via WebSocket

For event streams, pay once for a session of prepaid credits, then connect a WebSocket. Auto-topup when low. See README "WebSocket streaming" section.

## Endpoint Discovery

Two ways:

1. **Vybe API reference** — full endpoint catalog at https://docs.vybenetwork.com/reference. Every endpoint listed there is callable through the x402 API at the same path (`/v4/tokens/{mintAddress}`, `/v4/account/{ownerAddress}/pnl`, etc.) — just swap the base URL.
2. **Vybe MCP** — Vybe ships an MCP server with searchable endpoint metadata: https://docs.vybenetwork.com/docs/mcp. Useful if your agent runtime supports MCP. The MCP also exposes a `pay-with-x402` custom tool that returns step-by-step instructions for paying via this SDK — calling that tool first is a fast on-ramp for agents that just need to know "how do I pay for these endpoints?".

## Pricing

Discovery endpoint returns the current price table:

```bash
curl https://x402-api.vybenetwork.xyz/
```

Price tiers (heavier endpoints cost more — `GET /` is authoritative):

| Price | Example endpoints |
|-------|-------------------|
| $0.001 | token info, balances, known-accounts |
| $0.003 | candles, ohlcv |
| $0.005 | pnl, top-traders |
| $0.008 | top-holders, transfers, trades |
| $0.010 | batch POSTs (token-balances, etc.) |

## Error Handling

The SDK throws typed errors. Match on `instanceof`:

```ts
import {
  VybeClient,
  PaymentRequiredError,
  ApiError,
  NetworkError,
  BudgetExceededError,
  InsufficientCreditsError,
  ServiceUnavailableError,
  UntrustedPaymentError,
} from "@vybenetwork/x402-client";

try {
  const data = await client.get("/v4/tokens/...");
} catch (err) {
  if (err instanceof BudgetExceededError) { /* cumulative cap hit; stop */ }
  else if (err instanceof PaymentRequiredError) { /* 402 after retry — verify failed */ }
  else if (err instanceof ApiError) { /* API 4xx/5xx — err.status, err.body */ }
  else if (err instanceof NetworkError) { /* transport — likely RPC 429 in err.cause */ }
  else throw err;
}
```

| Error | Meaning | Action |
|-------|---------|--------|
| `PaymentRequiredError` | 402 returned after signed retry | Inspect `err.payment`. Usually means RPC blockhash expired in flight; retry. |
| `ApiError` (status 429) | Per-wallet rate limit (600/min/payer) | Backoff 1s, retry. Use multiple wallets to scale. |
| `ApiError` (status 4xx) | User error — bad path, bad params | Check `err.body`. Pay-on-success: 4xx still bills. |
| `ApiError` (status 5xx) | API failure | No charge — payment is abandoned server-side. Retry with backoff. |
| `NetworkError` | Transport error (DNS, RPC 429, fetch failure) | Inspect `err.cause`. Most common cause: client RPC throttled — use a paid tier. |
| `BudgetExceededError` | Cumulative spend cap hit | Stop or raise the cap. |
| `UntrustedPaymentError` | SDK refused to sign — payTo / network mismatch, or amount > `maxUsdPerCall` | No funds at risk (thrown before signing). Inspect `err.reason`. Raise `maxUsdPerCall` only after auditing the new pricing. |

## Inspecting Spend

```ts
client.budgetState();
// → { spentUsd: 0.027, capUsd: 1.00, remainingUsd: 0.973 }
```

## See Also

- README: https://github.com/vybenetwork/x402-client#readme
- x402 protocol: https://x402.org
- Vybe API reference: https://docs.vybenetwork.com/reference
- Vybe MCP: https://docs.vybenetwork.com/docs/mcp
- Helius (RPC): https://www.helius.dev/ — agent signup: https://dashboard.helius.dev/agents.md
