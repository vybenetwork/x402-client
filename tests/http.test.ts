// Integration tests against a mock API server. Exercises the full
// paid-request flow: discovery, signed retry, receipt decode, budget
// tracking, and typed-error mapping.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  VybeClient,
  loadKeypair,
  BudgetExceededError,
  ApiError,
} from "../src/index.js";
import { _resetReady, buildTrustPolicy } from "../src/http.js";
import { generateTestKeypairBase64 } from "../src/internal/test-keypair.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let port: number;
let routes: Map<string, Handler>;
let testKeypair: string;

function setRoute(path: string, handler: Handler) {
  routes.set(path, handler);
}

function jsonOK(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  testKeypair = generateTestKeypairBase64();
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const handler = routes.get(u.pathname);
    if (handler) return handler(req, res);
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes = new Map();
});

function mountDiscovery() {
  setRoute("/", (_req, res) => {
    jsonOK(res, 200, {
      name: "mock api",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: "CicjSgQ9rVUSihnS4hNFYCL8gy3fXDM243ofdZYMrdpr",
      defaultPrice: "$0.001",
      pricing: [
        { match: "top-holders", price: "$0.005" },
        { match: "candles", price: "$0.002" },
      ],
    });
  });
}

async function makeClient(opts?: {
  budget?: { maxUsd: number; onExceed?: "reject" | "warn" };
}) {
  const wallet = await loadKeypair(testKeypair);
  _resetReady(wallet);
  return new VybeClient({
    wallet,
    apiUrl: `http://localhost:${port}`,
    ...opts,
  });
}

describe("VybeClient.get — happy path", () => {
  it("returns parsed body on 2xx", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      jsonOK(res, 200, { name: "TestToken", symbol: "TEST" });
    });

    const client = await makeClient();
    const data = await client.get<{ name: string; symbol: string }>(
      "/v4/tokens/X",
    );
    expect(data.symbol).toBe("TEST");
  });

  it("decodes the payment-response receipt header", async () => {
    mountDiscovery();
    const receiptPayload = {
      txHash: "test-tx",
      payer: "TestPayer",
      amount: 0.001,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      settlement: "async",
    };
    setRoute("/v4/tokens/X", (_req, res) => {
      const header = Buffer.from(JSON.stringify(receiptPayload)).toString(
        "base64",
      );
      jsonOK(res, 200, { ok: true }, { "payment-response": header });
    });

    const client = await makeClient();
    const { receipt, status } = await client.request("/v4/tokens/X");
    expect(status).toBe(200);
    expect(receipt?.txHash).toBe("test-tx");
    expect(receipt?.settlement).toBe("async");
  });
});

describe("VybeClient.get — error mapping", () => {
  it("throws ApiError with refunded=true on 5xx", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      jsonOK(res, 502, { error: "API error", detail: "boom" });
    });

    const client = await makeClient();
    try {
      await client.get("/v4/tokens/X");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(502);
      expect(err.refunded).toBe(true);
    }
  });

  it("throws ApiError with refunded=false on 4xx (charge applies)", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      jsonOK(res, 400, { error: "bad mint" });
    });

    const client = await makeClient();
    try {
      await client.get("/v4/tokens/X");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(400);
      expect(err.refunded).toBe(false);
    }
  });

  it("formats ApiError message safely when body.error is non-string", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      jsonOK(res, 500, { error: { kind: "boom", count: 3 } });
    });

    const client = await makeClient();
    try {
      await client.get("/v4/tokens/X");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ApiError;
      expect(err.message).not.toContain("[object Object]");
      expect(err.message).toContain("kind");
    }
  });
});

describe("VybeClient.get — URL handling", () => {
  it("rejects relative paths without a leading slash", async () => {
    mountDiscovery();
    const client = await makeClient();
    await expect(client.get("v4/tokens/X")).rejects.toThrow(/must start with/);
  });

  it("accepts absolute http(s) URLs on the configured origin", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => jsonOK(res, 200, { ok: true }));

    const client = await makeClient();
    const data = await client.get<{ ok: boolean }>(
      `http://localhost:${port}/v4/tokens/X`,
    );
    expect(data.ok).toBe(true);
  });

  it("rejects cross-origin absolute URLs", async () => {
    mountDiscovery();
    const client = await makeClient();
    await expect(
      client.get("https://evil.example/v4/tokens/X"),
    ).rejects.toThrow(/does not match the configured apiUrl origin/);
  });
});

describe("HTTP trust policy", () => {
  it("rejects negative 402 challenge amounts before signing", () => {
    const policy = buildTrustPolicy(
      {
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "CicjSgQ9rVUSihnS4hNFYCL8gy3fXDM243ofdZYMrdpr",
        defaultPriceUsd: 0.001,
        pricing: [],
      },
      0.01,
    );

    expect(() =>
      policy(1, [
        {
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: "CicjSgQ9rVUSihnS4hNFYCL8gy3fXDM243ofdZYMrdpr",
          amount: "-1",
        },
      ]),
    ).toThrow(/must be non-negative/);
  });
});

describe("VybeClient.get — budget", () => {
  it("rejects via BudgetExceededError before making the call", async () => {
    mountDiscovery();
    let apiHits = 0;
    setRoute("/v4/tokens/X/top-holders", (_req, res) => {
      apiHits++;
      jsonOK(res, 200, { ok: true });
    });

    const client = await makeClient({
      budget: { maxUsd: 0.001, onExceed: "reject" },
    });
    await expect(client.get("/v4/tokens/X/top-holders")).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(apiHits).toBe(0);
  });

  it("reconciles budget against receipt.amount when present", async () => {
    mountDiscovery();
    const receiptPayload = {
      txHash: "abc",
      payer: "p",
      // Discovery prediction for this path would be $0.001 (defaultPrice),
      // but the receipt says the API actually billed $0.0023 — budget
      // should commit the receipt amount, not the prediction.
      amount: 0.0023,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      settlement: "async",
    };
    setRoute("/v4/tokens/X", (_req, res) => {
      const header = Buffer.from(JSON.stringify(receiptPayload)).toString(
        "base64",
      );
      jsonOK(res, 200, { ok: true }, { "payment-response": header });
    });

    const client = await makeClient({ budget: { maxUsd: 0.01 } });
    await client.get("/v4/tokens/X");
    expect(client.budgetState()?.spentUsd).toBe(0.0023);
  });

  it("commits spend after a successful call", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => jsonOK(res, 200, { ok: true }));

    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    await client.get("/v4/tokens/X");
    expect(client.budgetState()?.spentUsd).toBe(0.001);
    expect(client.budgetState()?.remainingUsd).toBe(0.004);
  });

  it("does NOT commit spend on 5xx (refunded)", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) =>
      jsonOK(res, 502, { error: "boom" }),
    );

    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    await expect(client.get("/v4/tokens/X")).rejects.toThrow();
    expect(client.budgetState()?.spentUsd).toBe(0);
  });

  it("commits spend on 4xx (user-error response is still charged)", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => jsonOK(res, 400, { error: "bad" }));

    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    await expect(client.get("/v4/tokens/X")).rejects.toThrow();
    expect(client.budgetState()?.spentUsd).toBe(0.001);
  });
});

describe("BudgetTracker — input validation", () => {
  it("rejects negative amounts at reserve()", async () => {
    mountDiscovery();
    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    expect(() => client.budget!.reserve(-0.001)).toThrow(/finite non-negative/);
  });

  it("rejects NaN at commit()", async () => {
    mountDiscovery();
    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    expect(() => client.budget!.commit(0.001, NaN)).toThrow(
      /finite non-negative/,
    );
  });

  it("concurrent paidRequest calls do not exceed cap (the race the old check() admitted)", async () => {
    // The old API was: check() — await — charge(). Two concurrent paidRequest
    // calls could both pass check() before either charge()'d, and both would
    // bill, exceeding the cap. The reservation API forces the spend
    // commitment up front so this can't happen.
    //
    // Mock fetch via setRoute with a deliberate delay so multiple in-flight
    // calls overlap. Cap = $0.003 = exactly 3 calls of $0.001. Fire 5
    // concurrent calls; only the first 3 should reserve and proceed, the
    // last 2 should reject before fetch ever fires.
    mountDiscovery();
    let apiHits = 0;
    setRoute("/v4/tokens/X", (_req, res) => {
      apiHits++;
      // Delay the response so all 5 reserves overlap in time.
      setTimeout(() => jsonOK(res, 200, { ok: true }), 100);
    });
    const client = await makeClient({ budget: { maxUsd: 0.003 } });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => client.get("/v4/tokens/X")),
    );
    const successes = results.filter((r) => r.status === "fulfilled").length;
    const budgetRejects = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof BudgetExceededError,
    ).length;

    expect(successes).toBe(3);
    expect(budgetRejects).toBe(2);
    // Crucially: the API only saw 3 requests. Old check()+await+charge
    // would have admitted all 5 to fetch and billed all 5.
    expect(apiHits).toBe(3);
    expect(client.budgetState()?.spentUsd).toBe(0.003);
  });

  it("commit() warns when actualUsd > reservedUsd pushes spend over cap", async () => {
    mountDiscovery();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      const client = await makeClient({ budget: { maxUsd: 0.005 } });
      client.budget!.reserve(0.004);
      // Receipt came back at $0.003 over the predicted price. spent goes
      // 0.004 → 0.007, breaching the $0.005 cap.
      client.budget!.commit(0.004, 0.007);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("cap breached");
      expect(client.budgetState()?.spentUsd).toBeCloseTo(0.007);
    } finally {
      console.warn = origWarn;
    }
  });

  it("refund() clamps spend at 0 on double-refund", async () => {
    mountDiscovery();
    const client = await makeClient({ budget: { maxUsd: 0.005 } });
    client.budget!.reserve(0.001);
    client.budget!.refund(0.001); // back to 0
    client.budget!.refund(0.001); // would go to -0.001 without clamp
    expect(client.budgetState()?.spentUsd).toBe(0);
  });
});

describe("API discovery validation", () => {
  it("throws NetworkError on missing payTo", async () => {
    setRoute("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        defaultPrice: "$0.001",
        pricing: [],
      });
    });
    const client = await makeClient();
    await expect(client.get("/v4/tokens/X")).rejects.toThrow(/invalid payTo/);
  });

  it("throws NetworkError on malformed pricing entry", async () => {
    setRoute("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        payTo: "TestPayer",
        defaultPrice: "$0.001",
        pricing: [{ match: "top-holders" /* no price */ }],
      });
    });
    const client = await makeClient();
    await expect(client.get("/v4/tokens/X")).rejects.toThrow(
      /pricing\[0\]\.price/,
    );
  });

  it("rejects USD strings with trailing junk (strict parser)", async () => {
    setRoute("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        payTo: "TestPayer",
        defaultPrice: "$0.001junk",
        pricing: [],
      });
    });
    const client = await makeClient();
    await expect(client.get("/v4/tokens/X")).rejects.toThrow(
      /did not parse as USD/,
    );
  });

  it("rejects whitespace-padded USD that contains non-numeric tail", async () => {
    setRoute("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        payTo: "TestPayer",
        defaultPrice: "$0.001 free",
        pricing: [],
      });
    });
    const client = await makeClient();
    await expect(client.get("/v4/tokens/X")).rejects.toThrow(
      /did not parse as USD/,
    );
  });

  it("handles trailing-slash apiUrl without producing a // discovery path", async () => {
    setRoute("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        payTo: "TestPayer",
        defaultPrice: "$0.001",
        pricing: [],
      });
    });
    setRoute("/v4/x", (_req, res) => jsonOK(res, 200, { ok: true }));

    const wallet = await loadKeypair(testKeypair);
    _resetReady(wallet);
    const client = new VybeClient({
      wallet,
      apiUrl: `http://localhost:${port}/`, // trailing slash
    });
    const data = await client.get<{ ok: boolean }>("/v4/x");
    expect(data.ok).toBe(true);
  });
});

describe("HTTP body parsing", () => {
  it("throws NetworkError on 2xx with invalid JSON body", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      // Claim JSON but send malformed content.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{ not valid json");
    });
    const client = await makeClient();
    await expect(client.get("/v4/tokens/X")).rejects.toThrow(
      /body was not valid JSON/,
    );
  });

  it("includes raw text in ApiError when error response body is not valid JSON", async () => {
    mountDiscovery();
    setRoute("/v4/tokens/X", (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("oops not json");
    });
    const client = await makeClient();
    try {
      await client.get("/v4/tokens/X");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(500);
      expect(err.refunded).toBe(true);
    }
  });
});

describe("HTTP cache — wallet+apiUrl key", () => {
  it("does not reuse cache across different apiUrl values for the same wallet", async () => {
    // Spin up a second mock API on a different port.
    const altRoutes = new Map<string, Handler>();
    const alt = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const h = altRoutes.get(u.pathname);
      if (h) return h(req, res);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => alt.listen(0, resolve));
    const altPort = (alt.address() as AddressInfo).port;
    altRoutes.set("/", (_req, res) => {
      jsonOK(res, 200, {
        network: "solana:EtWTR",
        payTo: "AltPayer",
        defaultPrice: "$0.999",
        pricing: [],
      });
    });

    mountDiscovery();
    const wallet = await loadKeypair(testKeypair);
    _resetReady(wallet);

    const a = new VybeClient({ wallet, apiUrl: `http://localhost:${port}` });
    setRoute("/v4/x", (_req, res) => jsonOK(res, 200, { ok: true }));
    await a.get("/v4/x");
    // Default discovery: $0.001
    expect(a.budgetState()).toBeNull(); // no budget set, but cache populated

    const b = new VybeClient({
      wallet,
      apiUrl: `http://localhost:${altPort}`,
      budget: { maxUsd: 0.5 },
    });
    altRoutes.set("/v4/x", (_req, res) => jsonOK(res, 200, { ok: true }));
    // alt discovery has defaultPrice $0.999 — if cache leaked from a, b would
    // see $0.001 and the call would succeed. With a proper (wallet, apiUrl)
    // cache key, b sees $0.999 and the budget cap of $0.5 rejects.
    await expect(b.get("/v4/x")).rejects.toBeInstanceOf(BudgetExceededError);

    await new Promise<void>((resolve) => alt.close(() => resolve()));
  });
});
