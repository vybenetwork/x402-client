# @vybenetwork/x402-client

[![npm](https://img.shields.io/npm/v/@vybenetwork/x402-client.svg)](https://www.npmjs.com/package/@vybenetwork/x402-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Client SDK for [Vybe's Solana analytics API](https://docs.vybenetwork.com/). Pay per call in USDC via the [x402 protocol](https://x402.org) — no API keys, no subscriptions, just bring a Solana wallet.

> ### Beta status
>
> - **The SDK is pre-release (0.1.x)** — the public API may change before 1.0.
> - **The service is in beta.** The x402 API endpoint, request/response shapes, error semantics, WS protocol, and per-route pricing can all change. Pin your dependency, watch the changelog.
> - **Beta runs on Solana mainnet.** Payments settle in real mainnet USDC. Check `GET /` on the API URL to confirm the live network at any time — that endpoint is authoritative.
> - **Pricing is currently a beta discount.** $0.001 default, $0.003 / $0.005 / $0.008 / $0.010 on heavier endpoints, $0.01 per WS session of 1000 credits. Hit `GET /` on the API URL for the live price table. These rates will go up at general availability — they exist to make beta usage cheap for early integrators. If you'd rather a traditional flat-fee subscription instead of pay-per-call, see [vybe.fyi/api-pricing](https://vybe.fyi/api-pricing).
> - **Rate limits.** 600 paid HTTP requests per minute per wallet (sliding window). High-traffic clients should batch where possible or run multiple wallets.
> - **You bring your own Solana RPC.** The SDK signs payments client-side, which calls Solana RPC twice per request (fetch USDC mint metadata + recent blockhash). Without `rpcUrl` set, it falls back to the public mainnet RPC, which rate-limits at ~5 RPS. Use a paid tier (Helius, Triton, QuickNode, etc.) — see [Configuration reference](#configuration-reference) below.

## Why

- **No signup, no keys.** A funded Solana wallet is all you need.
- **Pay-per-call HTTP.** Each request settles a USDC micropayment ($0.001 and up). 4xx user-error responses still bill (you got a real response); 5xx API failures refund automatically (no work delivered).
- **Prepaid WebSocket sessions.** One $0.01 payment buys 1000 credits (≈995 events after the 5-credit connection charge). Auto-topup before you run out.
- **Drop-in for AI agents.** Wire any Vybe endpoint into your model's tool-calling loop with `client.get()` / `client.request()` — no special AI helpers, full Vybe surface.
- **Budget caps.** Set `maxUsd` and the SDK rejects calls before signing.

## Install

```bash
npm install @vybenetwork/x402-client
```

## Setup (first run)

You need a **dedicated** Solana keypair with mainnet USDC. The API covers Solana transaction fees on every transfer, so **the wallet only needs USDC — no SOL required for gas.**

> **Use a dedicated wallet.** Don't point the SDK at a wallet you also use for trading, custody, or anything else. The keypair is held in process memory and signs USDC transfers per call (or per session); mixing API spend with other activity makes bookkeeping fragile and risks unintended charges if a balance check elsewhere assumes a USDC float that the SDK is quietly draining.

**1. Get a keypair.** Two paths — pick whichever is closer to where your USDC already lives:

- **A. Create one in your existing wallet** (Phantom, Solflare, Backpack, …) — most wallets let you add a new account in one click, then "Export Private Key" gives you a base58 string. This is the path most users take: your main wallet stays untouched, the new sub-account is the one the SDK signs with.
- **B. Generate fresh from the CLI** — useful for servers, CI, or anything headless. Requires the [Solana CLI](https://docs.solanalabs.com/cli/install):
  ```bash
  solana-keygen new --no-bip39-passphrase --outfile client.json
  node -e "console.log(Buffer.from(JSON.parse(require('fs').readFileSync('client.json'))).toString('base64'))"
  solana-keygen pubkey client.json   # the address to fund
  ```

`loadKeypair` auto-detects both formats — paste the base58 from option A directly, or the base64 from option B.

**2. Fund it with USDC** (mainnet, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). In order of how most people do it:

1. **Transfer from a wallet you already have** — open Phantom/Solflare/Backpack on your main account, send USDC to the new address. Quickest path if you're already on Solana.
2. **Bridge from another chain** if your USDC lives on Ethereum/Base/Arbitrum — use [Wormhole](https://portalbridge.com/), [deBridge](https://app.debridge.finance/), or Phantom's built-in bridge.
3. **Withdraw from a CEX** (Coinbase, Kraken, Binance, …) — slower but works from fiat. Pick "Solana network" and paste the address.

A few dollars goes a long way given default pricing of $0.001 per call.

**3. Wire it up.** Set the encoded keypair string as `CLIENT_PRIVATE_KEY` in your environment (or pass directly to `loadKeypair`). Treat it like any other secret — it's the full keypair, not just the pubkey. See [`.env.example`](./.env.example) for the full list of env vars the examples read.

## Quickstart

```ts
import { VybeClient, loadKeypair, ApiError, NetworkError } from "@vybenetwork/x402-client";

const client = new VybeClient({
  wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),
  rpcUrl: process.env.SOLANA_RPC_URL,        // strongly recommended (see Beta status)
  budget: { maxUsd: 1.00, onExceed: "reject" }, // optional safety cap
});

const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

try {
  // HTTP — auto-pays the $0.001 fee on first 402 challenge
  const token = await client.get(`/v4/tokens/${BONK_MINT}`);
  console.log(token);
} catch (err) {
  if (err instanceof ApiError) console.error(`API ${err.status}: ${err.message}`);
  else if (err instanceof NetworkError) console.error(`Transport: ${err.message}`);
  else throw err;
}
```

The endpoint, network, USDC mint, and pay-to address are inferred from the API's discovery endpoint (`GET /`) — you only bring your wallet. See [Errors](#errors) for the full type hierarchy.

## HTTP (pay-per-call)

The SDK is a thin pay-on-success wrapper over the [Vybe REST API](https://docs.vybenetwork.com/reference). Paths, query strings, request bodies, and response shapes are all unchanged — anything documented for Vybe works through `client.get()` / `client.request()`. The only thing the SDK adds on top is the x402 payment dance on the way in and a typed receipt on the way back.

> **Different base URL.** The SDK targets the pay-per-call x402 API at `https://x402-api.vybenetwork.xyz`, not the subscription API at `https://api.vybenetwork.xyz`. The SDK handles this for you — but if you're tailing logs, configuring egress rules, or sharing API calls with someone on the subscription side, you'll see the different host.

```ts
// Note: Vybe endpoints take SPL mint addresses, NOT ticker symbols.
// "BONK" is not valid input — use the actual mint address.
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

// GET — returns the parsed body on 2xx, throws a typed error on non-2xx
const holders = await client.get(`/v4/tokens/${BONK_MINT}/top-holders?limit=10`);

// Other methods — `request()` returns the parsed body plus payment receipt and
// status. It still throws the same typed errors as `get()` on non-2xx, so
// wrap in try/catch (or let it propagate) when error handling matters.
const { data, receipt, status } = await client.request("/v4/wallets/batch/token-balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  // Vybe's batch endpoints take `ownerAddresses` (an array of wallet
  // addresses, max 10), not `wallets`. See:
  // https://docs.vybenetwork.com/reference/post_wallet_tokens_many_v4
  body: JSON.stringify({ ownerAddresses: ["7EK976zyBWhYikjXGASSfN5KoNEekSLqx7wEkUJ8YkHv"] }),
});
console.log(`paid $${receipt?.amount} via ${receipt?.txHash}`);
```

Both `get()` and `request()` accept paths like `/v4/...` (joined with the configured API URL) or absolute URLs on the same origin. See the [Vybe API Reference](https://docs.vybenetwork.com/reference) for each endpoint's required fields.

## WebSocket streaming

```ts
// Vybe's WS filter keys are `trades`, `transfers`, `oraclePrices`,
// `priceCandles`, and `newToken` (all confirmed live through the x402 API;
// `newMarket` and `ageBucket` are accepted by the protocol but
// emit no events at the moment). Each takes an array of filter objects
// with optional `tokenMintAddress`, `marketId`, or `programId`. Empty
// array = "all events of that type".
// See: https://docs.vybenetwork.com/docs/filter-configuration
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const stream = await client.stream({
  filters: { trades: [{ tokenMintAddress: BONK_MINT }] },
});

for await (const event of stream) {
  console.log(event.data, "balance:", event.balance);
  if (event.warning === "LOW_BALANCE") console.warn("topping up soon");
}
```

The SDK pays $0.01 to mint a session (1000 credits, ≈995 events after the 5-credit connection charge), opens the WS, and yields each event with credit metadata. Auto-topup fires when the balance drops below the threshold (default `50`, set `0` or pass `autoTopup: false` to disable).

```ts
// Cancel via AbortSignal
const ctrl = new AbortController();
const stream = await client.stream({
  filters: { trades: [] },
  signal: ctrl.signal,
});
setTimeout(() => ctrl.abort(), 60_000);

// Or call .close() to end the stream
stream.close();

// Or break out of the for-await — the SDK closes the socket automatically
let received = 0;
for await (const ev of stream) {
  if (++received >= 100) break;
}
```

## Using with LLM agents

> **If you're on an MCP-aware host** (Claude Desktop, Cursor, Windsurf, VS Code with Copilot, etc.), you don't need this SDK at all — point the host at [Vybe's MCP server](https://docs.vybenetwork.com/docs/mcp) and the model can call all 35+ Vybe endpoints natively, no tool-spec wiring required. The rest of this section is for **building your own agent** that pays per call.

The SDK has no AI-specific helpers — wiring a Vybe endpoint into a model's tool-calling loop is just two steps:

1. **Write a JSON Schema tool spec** for the endpoint you want. Copy the parameter list straight from the [Vybe API reference](https://docs.vybenetwork.com/reference). Spec format: [OpenAI](https://platform.openai.com/docs/guides/function-calling), [Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/tool-use).
2. **Dispatch the model's `tool_call`** to `client.get()` (for GETs) or `client.request()` (for POSTs and others). Send the response back to the model as a `tool` message.

```ts
const topHoldersTool = {
  type: "function",
  function: {
    name: "get_token_top_holders",
    description: "Top wallets holding a Solana SPL token, ranked by balance.",
    parameters: {
      type: "object",
      properties: {
        // SPL mint address — system-prompt the model to use mints, not
        // ticker symbols. "USDC" / "BONK" will fail the API.
        mintAddress: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["mintAddress"],
    },
  },
};

// ...inside your tool-call handler:
if (call.function.name === "get_token_top_holders") {
  const { mintAddress, limit } = JSON.parse(call.function.arguments);
  const data = await client.get(
    `/v4/tokens/${encodeURIComponent(mintAddress)}/top-holders?limit=${limit ?? 10}`,
  );
  // push `data` back to the model as a tool message...
}
```

For POST endpoints (wallet batch, trading swap, etc.), use `client.request(path, { method: "POST", headers, body })` — see the [HTTP section](#http-pay-per-call) above.

**Budget cap for runaway models.** Set `budget: { maxUsd, onExceed: "reject" }` on the client. `client.get()` / `request()` will throw `BudgetExceededError` once cumulative spend passes the cap; catch it and surface to the model as a tool error so it knows to stop.

A full runnable example is in [`examples/agent.ts`](./examples/agent.ts).

## Wallet

`loadKeypair` accepts the three formats you actually have on hand:

| Format | Source | Example call |
|---|---|---|
| Base58 string | Most wallets' "Export Private Key" — Phantom, Solflare, Backpack, etc. | `await loadKeypair("3NYE…")` |
| Base64 string | A `solana-keygen` JSON file piped through `base64`. Safe to hold in env vars. | `await loadKeypair(process.env.CLIENT_PRIVATE_KEY!)` |
| JSON file path (Node only) | Solana CLI keypair files — `~/.config/solana/id.json` style. | `await loadKeypair.fromFile("./client.json")` |

The format is auto-detected from the string contents. The keypair is held in module-private memory; the only thing the SDK exposes back is the public address (`wallet.address`).

See [Setup](#setup-first-run) for the full generate-and-fund flow. The API covers Solana transaction fees, so the wallet only needs USDC — no SOL required. Always confirm the live network with `GET /` on the API URL; that endpoint is authoritative.

## Budget control

```ts
const client = new VybeClient({
  wallet,
  budget: { maxUsd: 1.00, onExceed: "reject" }, // "warn" to log instead
});
// Throws BudgetExceededError before signing once cumulative spend would
// exceed $1. WS sessions and topups also count.

console.log(client.budgetState()); // { capUsd: 1, spentUsd: 0.013, remainingUsd: 0.987 }
```

## Errors

Catch with `instanceof`:

| Error | When | Notes |
|---|---|---|
| `PaymentRequiredError` | API rejected the payment | Includes `amountUsd`, `payTo`, `network` |
| `ApiError` | Non-2xx (not 402) | `status`, `refunded`, `chargedUsd` |
| `ServiceUnavailableError` | Vybe API down | Retry with backoff |
| `InsufficientCreditsError` | WS session ran out of credits | Carries final `balance` |
| `BudgetExceededError` | Call would push spend over `maxUsd` | Carries `attemptedUsd`, `capUsd`, `spentUsd` |
| `UntrustedPaymentError` | SDK refused to sign a 402 (bad payTo, network, or over `maxUsdPerCall`) | `reason`; no funds at risk — thrown before signing |
| `NetworkError` | Transport / DNS / parse failure | Wraps the underlying cause |
| `VybeError` | Base class for all of the above | Catch-all |

`ApiError.refunded === true` means the API abandoned the payment (typically 5xx). `false` means the call billed despite the error (typically 4xx user errors). `chargedUsd` reflects the actual amount taken.

```ts
import {
  ApiError, BudgetExceededError, InsufficientCreditsError,
  PaymentRequiredError, ServiceUnavailableError, NetworkError,
  UntrustedPaymentError,
} from "@vybenetwork/x402-client";

try {
  const data = await client.get("/v4/tokens/<mint>/top-holders?limit=10");
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // We hit our self-imposed cap. Stop, tell the user, raise the cap,
    // or wait — the SDK didn't sign anything for this call.
    console.error(`Stopped at $${err.spentUsd.toFixed(3)} of $${err.capUsd.toFixed(3)} cap`);
  } else if (err instanceof PaymentRequiredError) {
    // API refused the payment (bad signature, expired tx, etc.).
    // Usually transient — retry. If persistent, check the wallet has
    // USDC on Solana mainnet (the wallet doesn't need SOL — the API
    // covers Solana gas).
  } else if (err instanceof ApiError) {
    // API returned a non-2xx, non-402 status.
    if (err.refunded) console.error(`API ${err.status} — no charge`);
    else              console.error(`API ${err.status} — billed $${err.chargedUsd.toFixed(4)}`);
  } else if (err instanceof ServiceUnavailableError) {
    // Vybe API is degraded. Retry with backoff.
  } else if (err instanceof InsufficientCreditsError) {
    // Only thrown by client.stream() when the WS session is exhausted.
    // The session is dead; mint a new one with another client.stream().
  } else if (err instanceof NetworkError) {
    // DNS / connection / timeout / body-parse. Retry, but log .cause —
    // 429s from the public Solana RPC surface here when rpcUrl isn't set.
  }
}
```

## Browser

The SDK ships an ESM browser bundle (`dist/index.browser.js`) that maps the `ws` package to the platform's native WebSocket. Bundlers that respect the `browser` package field pick it up automatically.

**That said, do not use this SDK in a browser with a raw private key.** `loadKeypair` takes a base58 or base64 keypair, which would be visible to any user (or extension, or DevTools tab) with access to the page. Real browser usage requires wallet-adapter signing (Phantom, Solflare, etc.) — which the SDK doesn't currently support. Server-side Node is the realistic target today.

The x402 API also doesn't have CORS configured yet; in practice the browser bundle is for a future use case, not a present one.

## Using the API without the SDK

The SDK is just convenience. The wire protocol is [x402](https://x402.org) over HTTP plus a small JSON session API for WebSocket. If you'd rather build against the wire directly — for a non-Node language, a thin shell script, or to keep your dependency tree small — the recipes below cover everything the SDK does.

### HTTP: 402 challenge + signed retry

Every `/v4/*` request expects a payment. The first call returns 402 with the requirements; sign a USDC transfer matching them and retry with the signed payload in an `X-PAYMENT` header. On 2xx, a base64-encoded `payment-response` header carries the receipt.

```bash
# 1. First call — API returns 402 with what to pay
curl -i https://x402-api.vybenetwork.xyz/v4/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

# HTTP/2 402
# content-type: application/json
# {
#   "x402Version": 2,
#   "accepts": [{
#     "scheme": "exact",
#     "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
#     "amount": "1000",                // 0.001 USDC in atomic units (6 decimals)
#     "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // mainnet USDC mint (devnet differs)
#     "payTo": "Cic...",               // pay-to address (the API publishes this)
#     "maxTimeoutSeconds": 3600,
#     "extra": { "feePayer": "..." }   // API covers Solana gas
#   }]
# }
```

To sign: build a USDC SPL token transfer matching `accepts[0]`, sign it with your wallet, base64-encode the signed transaction inside the [x402 payment payload](https://github.com/coinbase/x402/blob/main/specs/x402-specification.md), and resend the request with the payload in the `X-PAYMENT` header. The x402 API verifies the payment, settles it on-chain, and forwards the response. Successful responses include a `payment-response` header (base64 JSON) with `txHash`, `amount`, and `settlement` mode.

The [x402 reference implementations](https://github.com/coinbase/x402#sdks) cover Solana signing in TypeScript, Go, Python, and Rust — picking up the SDK becomes a 10-line wrapper around `@x402/core` + `@x402/svm`. There's no protocol secret sauce in this SDK.

### CLI / MCP alternative

If you don't want any dependency at all, [x402-proxy](https://github.com/cascade-protocol/x402-proxy) is a third-party `curl`-style CLI and MCP proxy that auto-pays any x402 endpoint, including Vybe:

```bash
npx x402-proxy https://x402-api.vybenetwork.xyz/v4/tokens/<mintAddress>
```

It derives keys from a mnemonic, signs the USDC transfer, retries with the payment header, and streams the response. Also runs as an MCP server, so AI hosts like Claude Desktop, Cursor, or Windsurf can call Vybe over stdio MCP without this SDK. Equally valid path — pick whichever fits the deployment.

### WebSocket: prepaid sessions

Streaming uses one x402 payment to mint a prepaid session, then connects to `/live` with a JWT.

```bash
# 1. Pay $0.01 to mint a session (same x402 dance, POST instead of GET)
curl -X POST -H "X-PAYMENT: <signed payload>" \
  https://x402-api.vybenetwork.xyz/api/sessions
# → 201 { "sessionId": "...", "jwt": "<jwt-string>", "credits": 1000, "expiresAt": "..." }
```

```js
// 2. Connect with the JWT from step 1's response, send Vybe's
//    configure message verbatim. Query param is `jwt` (not `token`)
//    to disambiguate from SPL token.
const { sessionId, jwt } = await sessionResponse.json(); // from step 1
const ws = new WebSocket(`wss://x402-api.vybenetwork.xyz/live?jwt=${jwt}`);
ws.onopen = () => ws.send(JSON.stringify({
  type: "configure",
  filters: { trades: [{ tokenMintAddress: "..." }] },  // see Vybe's WS filter docs
}));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "connected") return;                     // session info frame
  // Event frame: { data, credits: { balance, cost, warning? } }
  console.log(msg.data, "balance:", msg.credits.balance);
};
```

```bash
# 3. Top up before credits run out (default cap at balance < 50)
curl -X POST -H "X-PAYMENT: <signed payload>" \
  -H "Authorization: Bearer <jwt>" \
  -H "Idempotency-Key: <uuid>" \
  https://x402-api.vybenetwork.xyz/api/sessions/<sessionId>/topup
# → 200 { "creditsAdded": 1000, "balance": ..., "jwt": "<refreshed-jwt>", ... }
```

The WebSocket close codes the SDK maps to typed errors are documented but stable: `4010` insufficient credits, `4503` API unavailable, `4001`/`4002`/`4008` auth/protocol errors. `1000`/`1001` are normal closes.

### Discovery

`GET /` returns network, pay-to, and per-route pricing. The SDK uses this to build the x402 signer and predict cost; you can hit it the same way to avoid hardcoding addresses.

```bash
curl https://x402-api.vybenetwork.xyz/
# → { "network": "solana:...", "payTo": "...", "defaultPrice": "$0.001",
#     "pricing": [{ "match": "top-holders", "price": "$0.008" }, ...] }
```

## Configuration reference

```ts
new VybeClient({
  wallet,                                             // required — from loadKeypair()
  apiUrl: "https://x402-api.vybenetwork.xyz",         // default; override only for staging/self-host
  rpcUrl: "https://my-paid-rpc/...",                  // strongly recommended — see below
  budget: { maxUsd, onExceed },                       // optional cumulative-spend cap
  maxUsdPerCall: 0.10,                                // per-call hard cap, default $0.10
  autotopupThreshold: 50,                             // WS auto-topup trigger (0 disables)
});
```

### `maxUsdPerCall` (per-call hard cap)

The SDK refuses to sign any 402 challenge demanding more than this amount, throwing `UntrustedPaymentError` *before* the signature is produced. Default: $0.10 — 10× the highest known endpoint tier. It's a defense against API misconfiguration, a 402 injected by a man-in-the-middle, or unexpected price drift. Complements `budget.maxUsd` (cumulative cap): `maxUsdPerCall` bounds a single transfer, `budget.maxUsd` bounds the running total.

```ts
import { VybeClient, UntrustedPaymentError } from "@vybenetwork/x402-client";

try {
  await client.get("/v4/tokens/<mint>");
} catch (err) {
  if (err instanceof UntrustedPaymentError) {
    // err.reason is "payTo_mismatch" | "network_mismatch" | "amount_exceeds_per_call_cap"
    console.error(`SDK refused to sign: ${err.reason} — ${err.message}`);
  }
}
```

Raise it if you've audited a higher-priced endpoint; lower it for tighter control.

### `rpcUrl` (Solana RPC for client-side signing)

The SDK signs each x402 payment client-side, which makes two read-only RPC calls (`fetchMint` + `getLatestBlockhash`) per paid request. Without `rpcUrl`, it falls back to whatever `@x402/svm` picks — currently the public mainnet RPC, which rate-limits at roughly 5 RPS and surfaces as `NetworkError` with a `429: Too Many Requests` cause as soon as you have any concurrency.

For anything beyond casual sequential use, set this to a paid tier:

```ts
const client = new VybeClient({
  wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),
  rpcUrl: process.env.SOLANA_RPC_URL,   // Helius / Triton / QuickNode / etc.
});
```

Need a free RPC to get started? [Helius](https://www.helius.dev/) has a free tier (10 RPS, no card) — sign up, paste the URL into `rpcUrl`. Agents can also obtain one autonomously via the Helius CLI ($1 USDC, no browser): see their [agents.md](https://dashboard.helius.dev/agents.md).

## Examples

Runnable scripts in [`examples/`](./examples):

- `examples/http.ts` — paid HTTP requests
- `examples/ws-stream.ts` — WebSocket streaming with auto-topup
- `examples/agent.ts` — LLM tool-call loop

Run with `CLIENT_PRIVATE_KEY=<base64> npx tsx examples/<file>.ts`.

## For AI agents

See [AGENTS.md](./AGENTS.md) — machine-readable onboarding doc covering install, prerequisites, the paid-call flow, error semantics, and discovery.

## Support

Hit a bug, an unclear error, or want an endpoint added to the curated tool catalog? Open an issue on this repo, or reach out via the Intercom widget on [vybe.fyi](https://vybe.fyi/) — we'll see it directly.

For traditional subscription pricing instead of pay-per-call x402, see [vybe.fyi/api-pricing](https://vybe.fyi/api-pricing).

## Development

```bash
npm install
npm test               # vitest
npm run typecheck
npm run build          # ESM + CJS + browser bundle
```

## License

MIT
