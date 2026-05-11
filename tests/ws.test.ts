// Mock-API integration tests for the WebSocket streaming client. The mock
// HTTP server handles /api/sessions (skipping the x402 payment challenge —
// returning 200 directly with a canned session). A WebSocket server runs on
// the same http.Server's /live path, accepting the test client and sending
// scripted frames.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as WS, WebSocketServer } from "ws";
import { VybeClient, loadKeypair, ServiceUnavailableError, InsufficientCreditsError, BudgetExceededError } from "../src/index.js";
import { _resetReady } from "../src/http.js";
import { generateTestKeypairBase64 } from "../src/internal/test-keypair.js";

let server: http.Server;
let port: number;
let httpRoutes: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;
let wss: WebSocketServer;
let testKeypair: string;
const acceptedSockets: WS[] = [];

function jsonOK(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function mountDiscovery() {
  httpRoutes.set("/", (_req, res) => {
    jsonOK(res, 200, {
      name: "mock api",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: "CicjSgQ9rVUSihnS4hNFYCL8gy3fXDM243ofdZYMrdpr",
      defaultPrice: "$0.001",
      // Mirror the real API: session purchases priced via the "sessions"
      // segment match. Budget pre-check uses this.
      pricing: [{ match: "sessions", price: "$0.01" }],
    });
  });
}

// Mount a /api/sessions handler that returns a canned session immediately
// (bypasses the x402 challenge). Optionally tracks creation count.
function mountSessionCreate(opts?: { credits?: number; counter?: { count: number } }) {
  httpRoutes.set("/api/sessions", (_req, res) => {
    if (opts?.counter) opts.counter.count += 1;
    jsonOK(res, 201, {
      sessionId: "ses_test_abc123",
      jwt: "fake.jwt.value",
      credits: opts?.credits ?? 1000,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      pricing: {},
    });
  });
}

function mountTopup(opts?: { credits?: number; counter?: { count: number } }) {
  httpRoutes.set("/api/sessions/ses_test_abc123/topup", (_req, res) => {
    if (opts?.counter) opts.counter.count += 1;
    jsonOK(res, 200, {
      creditsAdded: opts?.credits ?? 1000,
      balance: opts?.credits ?? 1000,
      alreadyProcessed: false,
      jwt: "fake.jwt.refreshed",
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
  });
}

beforeAll(async () => {
  testKeypair = generateTestKeypairBase64();
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const handler = httpRoutes.get(u.pathname);
    if (handler) return handler(req, res);
    res.writeHead(404);
    res.end();
  });
  wss = new WebSocketServer({ server, path: "/live" });
  wss.on("connection", sock => {
    acceptedSockets.push(sock);
    // Mimic the real API's "connected" frame on open.
    sock.send(JSON.stringify({
      type: "connected",
      sessionId: "ses_test_abc123",
      balance: 995,
      connectionCost: 5,
    }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of acceptedSockets) try { s.close(); } catch { /* ignore */ }
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  httpRoutes = new Map();
  acceptedSockets.length = 0;
});

async function makeClient(extra?: Record<string, unknown>) {
  const wallet = await loadKeypair(testKeypair);
  _resetReady(wallet);
  return new VybeClient({
    wallet,
    apiUrl: `http://localhost:${port}`,
    ...extra,
  });
}

function pushEvent(sock: WS, data: unknown, balance: number, cost = 1, warning?: string) {
  sock.send(JSON.stringify({
    data,
    credits: { balance, cost, ...(warning ? { warning } : {}) },
  }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise(r => setTimeout(r, 10));
  }
}

describe("openStream — basic streaming", () => {
  it("yields events through the async iterator with credit metadata", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream<{ tag: string }>({ filters: { newToken: [] } });

    await waitFor(() => acceptedSockets.length === 1);
    const sock = acceptedSockets[0]!;

    // Push three events
    pushEvent(sock, { tag: "a" }, 990);
    pushEvent(sock, { tag: "b" }, 989);
    pushEvent(sock, { tag: "c" }, 988);

    const collected: Array<{ data: { tag: string }; balance: number }> = [];
    for await (const ev of stream) {
      collected.push({ data: ev.data, balance: ev.balance });
      if (collected.length === 3) break;
    }
    expect(collected.map(e => e.data.tag)).toEqual(["a", "b", "c"]);
    expect(collected[2]!.balance).toBe(988);

    stream.close();
  });

  it("forwards the configure message to the API verbatim", async () => {
    mountDiscovery();
    mountSessionCreate();

    const received: unknown[] = [];
    const onMsg = (sock: WS) => sock.on("message", buf => received.push(JSON.parse(buf.toString())));
    wss.once("connection", onMsg);

    const client = await makeClient();
    const stream = await client.stream({
      filters: { newToken: [], ohlcv: ["BONK"] },
    });

    await waitFor(() => received.length >= 1);
    expect(received[0]).toEqual({
      type: "configure",
      filters: { newToken: [], ohlcv: ["BONK"] },
    });

    stream.close();
  });

  it("close() ends the iterator and shuts the socket", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream({ filters: { newToken: [] } });

    await waitFor(() => acceptedSockets.length === 1);
    stream.close();

    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    expect(out).toHaveLength(0);
  });

  it("AbortSignal cancels the stream", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const ctrl = new AbortController();
    const stream = await client.stream({
      filters: { newToken: [] },
      signal: ctrl.signal,
    });

    await waitFor(() => acceptedSockets.length === 1);
    ctrl.abort();

    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    expect(out).toHaveLength(0);
  });
});

describe("openStream — error mapping on close codes", () => {
  it("4010 → InsufficientCreditsError on iterator", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);

    acceptedSockets[0]!.close(4010, "INSUFFICIENT_CREDITS");

    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsufficientCreditsError);
  });

  it("4503 → ServiceUnavailableError on iterator", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);

    acceptedSockets[0]!.close(4503, "BRIDGE_DOWN");

    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
  });
});

describe("openStream — auto-topup", () => {
  it("fires topup when balance falls below threshold", async () => {
    mountDiscovery();
    mountSessionCreate({ credits: 1000 });
    const topupCounter = { count: 0 };
    mountTopup({ credits: 1000, counter: topupCounter });

    const client = await makeClient({ autotopupThreshold: 50 });
    const stream = await client.stream({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);
    const sock = acceptedSockets[0]!;

    // Push an event that drops balance under the threshold.
    pushEvent(sock, { x: 1 }, 49);

    // Drain the event so the iterator advances; auto-topup runs in the
    // background after we observe the low-balance event.
    const it = stream[Symbol.asyncIterator]();
    await it.next();

    await waitFor(() => topupCounter.count === 1, 2000);
    expect(topupCounter.count).toBe(1);

    stream.close();
  });

  it("does not fire when autoTopup: false even if threshold is crossed", async () => {
    mountDiscovery();
    mountSessionCreate({ credits: 1000 });
    const topupCounter = { count: 0 };
    mountTopup({ counter: topupCounter });

    const client = await makeClient({ autotopupThreshold: 50 });
    const stream = await client.stream({
      filters: { newToken: [] },
      autoTopup: false,
    });
    await waitFor(() => acceptedSockets.length === 1);

    pushEvent(acceptedSockets[0]!, { x: 1 }, 10); // below threshold

    const it = stream[Symbol.asyncIterator]();
    await it.next();
    await new Promise(r => setTimeout(r, 200));
    expect(topupCounter.count).toBe(0);

    stream.close();
  });

  it("threshold of 0 disables auto-topup", async () => {
    mountDiscovery();
    mountSessionCreate({ credits: 1000 });
    const topupCounter = { count: 0 };
    mountTopup({ counter: topupCounter });

    const client = await makeClient({ autotopupThreshold: 0 });
    const stream = await client.stream({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);

    pushEvent(acceptedSockets[0]!, { x: 1 }, 5);
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    await new Promise(r => setTimeout(r, 200));
    expect(topupCounter.count).toBe(0);

    stream.close();
  });
});

describe("openStream — budget", () => {
  it("rejects via BudgetExceededError before opening a session if cap is too low", async () => {
    mountDiscovery();
    let sessionsCreated = 0;
    httpRoutes.set("/api/sessions", (_req, res) => {
      sessionsCreated += 1;
      jsonOK(res, 201, {});
    });

    // $0.005 cap, session costs $0.01 → budget reject before paidRequest fires
    const client = await makeClient({ budget: { maxUsd: 0.005, onExceed: "reject" } });
    await expect(client.stream({ filters: {} })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sessionsCreated).toBe(0);
  });
});

describe("openStream — input validation", () => {
  it("throws when filters is missing", async () => {
    mountDiscovery();
    const client = await makeClient();
    // @ts-expect-error testing runtime guard
    await expect(client.stream({})).rejects.toThrow(/filters must be a plain object/);
  });

  it("rejects non-object filters (string)", async () => {
    mountDiscovery();
    const client = await makeClient();
    // @ts-expect-error testing runtime guard
    await expect(client.stream({ filters: "newToken" })).rejects.toThrow(/filters must be a plain object/);
  });

  it("rejects array filters", async () => {
    mountDiscovery();
    const client = await makeClient();
    // @ts-expect-error testing runtime guard
    await expect(client.stream({ filters: ["newToken"] })).rejects.toThrow(/filters must be a plain object/);
  });

  it("rejects already-aborted signal before paying", async () => {
    mountDiscovery();
    let sessionsCreated = 0;
    httpRoutes.set("/api/sessions", (_req, res) => {
      sessionsCreated += 1;
      jsonOK(res, 201, {});
    });

    const client = await makeClient();
    const ctrl = new AbortController();
    ctrl.abort(new Error("user aborted"));

    await expect(client.stream({ filters: { newToken: [] }, signal: ctrl.signal }))
      .rejects.toThrow(/user aborted/);
    expect(sessionsCreated).toBe(0);
  });
});

describe("openStream — URL handling", () => {
  it("handles apiUrl with trailing slash without producing //live", async () => {
    mountDiscovery();
    mountSessionCreate();

    const wallet = await loadKeypair(testKeypair);
    _resetReady(wallet);
    const client = new VybeClient({
      wallet,
      apiUrl: `http://localhost:${port}/`,
    });

    const stream = await client.stream({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);
    stream.close();
  });
});

describe("openStream — frame validation", () => {
  it("drops event frames missing credits.cost", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream<{ tag: string }>({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);
    const sock = acceptedSockets[0]!;

    // Malformed: balance present but cost missing — should be dropped, not
    // pushed with cost: undefined (which would violate StreamEvent.cost: number).
    sock.send(JSON.stringify({ data: { tag: "bad" }, credits: { balance: 100 } }));
    pushEvent(sock, { tag: "good" }, 99);

    const collected: Array<{ tag: string }> = [];
    for await (const ev of stream) {
      collected.push(ev.data);
      if (collected.length === 1) break;
    }
    expect(collected).toEqual([{ tag: "good" }]);
    stream.close();
  });
});

describe("for-await break — shuts down WebSocket", () => {
  it("breaking out of the iterator closes the underlying socket", async () => {
    mountDiscovery();
    mountSessionCreate();

    const client = await makeClient();
    const stream = await client.stream<{ tag: string }>({ filters: { newToken: [] } });
    await waitFor(() => acceptedSockets.length === 1);
    const sock = acceptedSockets[0]!;

    pushEvent(sock, { tag: "a" }, 990);

    for await (const _ev of stream) {
      break; // should call iterator return() → stream.close() → ws.close
    }

    await waitFor(() => sock.readyState === sock.CLOSING || sock.readyState === sock.CLOSED, 1500);
  });
});
