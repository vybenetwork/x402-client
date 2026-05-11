// LLM tool-calling example. The SDK has no AI-specific helpers — the
// pattern is just: hand-write a JSON-Schema tool spec for whatever Vybe
// endpoint you want, dispatch the model's tool_call to client.get() or
// client.request(). This file shows one endpoint wired up.
//
// Run: OPENAI_API_KEY=... CLIENT_PRIVATE_KEY=<base64> npx tsx examples/agent.ts

import { VybeClient, loadKeypair } from "../src/index.js";

// Tool spec for /v4/tokens/{mintAddress}/top-holders. Copy the parameter
// list straight from the Vybe reference page:
// https://docs.vybenetwork.com/reference/get_top_holders_v4
const tokenTopHoldersSpec = {
  type: "function" as const,
  function: {
    name: "get_token_top_holders",
    description: "Top wallets holding a Solana SPL token, ranked by balance.",
    parameters: {
      type: "object",
      properties: {
        mintAddress: {
          type: "string",
          description: "SPL token mint address (base58, NOT a ticker symbol).",
        },
        limit: { type: "integer", description: "Max holders (default 10, max 1000)." },
      },
      required: ["mintAddress"],
      additionalProperties: false,
    },
  },
};

async function main() {
  const client = new VybeClient({
    wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),
    rpcUrl: process.env.SOLANA_RPC_URL,
    budget: { maxUsd: 0.50, onExceed: "reject" },
  });

  // Pretend OpenAI returned this tool_call from a chat completion. In
  // real code the args come from the model.
  const llmCall = {
    name: "get_token_top_holders",
    arguments: { mintAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", limit: 3 },
  };

  // Dispatch: build the path from the model's args and call the SDK.
  // get() because /v4/tokens/.../top-holders is a GET.
  if (llmCall.name === "get_token_top_holders") {
    const { mintAddress, limit } = llmCall.arguments;
    const data = await client.get(
      `/v4/tokens/${encodeURIComponent(mintAddress)}/top-holders?limit=${limit}`,
    );
    console.log("Result:", data);
    // In a real loop you'd push this back to the model as a `tool` message
    // so the next turn can use it.
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
