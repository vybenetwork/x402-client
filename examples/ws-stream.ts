// WebSocket streaming example with auto-topup.
//
// Run: CLIENT_PRIVATE_KEY=<base64> npx tsx examples/ws-stream.ts

import { VybeClient, loadKeypair } from "../src/index.js";

async function main() {
  const client = new VybeClient({
    wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),
    autotopupThreshold: 50,
  });

  // Vybe's WS filter keys are `trades`, `transfers`, `oraclePrices`. Each
  // takes an array of filter objects with optional `tokenMintAddress`,
  // `marketId`, or `programId`. Empty array = "all events of that type".
  // See https://docs.vybenetwork.com/docs/filter-configuration.
  const stream = await client.stream({
    filters: { trades: [] },
  });

  for await (const event of stream) {
    console.log(
      `event balance=${event.balance} cost=${event.cost}${event.warning ? ` [${event.warning}]` : ""}`,
      event.data,
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
