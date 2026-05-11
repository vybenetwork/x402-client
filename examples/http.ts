// Pay-per-call HTTP example.
//
// Run: CLIENT_PRIVATE_KEY=<base64> npx tsx examples/http.ts

import { VybeClient, loadKeypair } from "../src/index.js";

async function main() {
  const client = new VybeClient({
    wallet: await loadKeypair(process.env.CLIENT_PRIVATE_KEY!),
  });

  // $0.001 default
  const tokenInfo = await client.get("/v4/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  console.log("Token:", tokenInfo);

  // $0.005 (premium route)
  const holders = await client.get("/v4/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/top-holders?limit=3");
  console.log("Top holders:", holders);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
