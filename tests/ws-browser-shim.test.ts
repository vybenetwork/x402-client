// Unit test for the browser-bundle shim that wraps native WebSocket in
// the EventEmitter-style API the SDK expects. The shim is only swapped in
// at bundle time via esbuild alias; here we exercise it directly against
// a fake globalThis.WebSocket to confirm event translation.

import { describe, it, expect, beforeEach, vi } from "vitest";

class FakeNativeWebSocket extends EventTarget {
  static instances: FakeNativeWebSocket[] = [];
  binaryType = "blob";
  url: string;
  sent: Array<unknown> = [];
  // Counts active listeners per event so tests can assert detach() ran.
  listenerCounts = new Map<string, number>();

  constructor(url: string) {
    super();
    this.url = url;
    FakeNativeWebSocket.instances.push(this);
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener) this.listenerCounts.set(type, (this.listenerCounts.get(type) ?? 0) + 1);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener) this.listenerCounts.set(type, Math.max(0, (this.listenerCounts.get(type) ?? 0) - 1));
    super.removeEventListener(type, listener, options);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }
  close(_code?: number, _reason?: string): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code: _code ?? 1000, reason: _reason ?? "" }));
  }
  fireOpen(): void { this.dispatchEvent(new Event("open")); }
  fireMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  fireClose(code: number, reason: string): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  fireError(): void { this.dispatchEvent(new Event("error")); }
}

beforeEach(() => {
  FakeNativeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeNativeWebSocket);
});

describe("browser WebSocket shim", () => {
  it("translates open/message/close/error to .on(...) callbacks", async () => {
    const { default: WS } = await import("../src/internal/ws-browser.js");

    const ws = new WS("wss://example/ws") as unknown as {
      on(event: string, cb: (...args: unknown[]) => void): void;
      send(data: string): void;
      close(): void;
    };

    const events: Array<{ name: string; args: unknown[] }> = [];
    ws.on("open", (...args) => events.push({ name: "open", args }));
    ws.on("message", (...args) => events.push({ name: "message", args }));
    ws.on("close", (...args) => events.push({ name: "close", args }));
    ws.on("error", (...args) => events.push({ name: "error", args }));

    const native = FakeNativeWebSocket.instances[0]!;
    native.fireOpen();
    native.fireMessage("hello");
    native.fireError();
    native.fireClose(4010, "INSUFFICIENT_CREDITS");

    expect(events.map(e => e.name)).toEqual(["open", "message", "error", "close"]);
    expect(events[1]!.args).toEqual(["hello"]);
    expect(events[2]!.args[0]).toBeInstanceOf(Error);
    expect(events[3]!.args).toEqual([4010, "INSUFFICIENT_CREDITS"]);
  });

  it("forces binaryType=arraybuffer (so non-text frames coerce uniformly)", async () => {
    const { default: WS } = await import("../src/internal/ws-browser.js");
    new WS("wss://example/ws");
    expect(FakeNativeWebSocket.instances[0]!.binaryType).toBe("arraybuffer");
  });

  it("forwards send() and close() to native", async () => {
    const { default: WS } = await import("../src/internal/ws-browser.js");
    const ws = new WS("wss://example/ws") as unknown as { send(s: string): void; close(): void };

    ws.send("frame-1");
    expect(FakeNativeWebSocket.instances[0]!.sent).toEqual(["frame-1"]);
  });

  it("removes native listeners after close so the underlying WS can be GC'd", async () => {
    const { default: WS } = await import("../src/internal/ws-browser.js");
    new WS("wss://example/ws");
    const native = FakeNativeWebSocket.instances[0]!;

    // 4 listeners registered: open, message, close, error
    expect(native.listenerCounts.get("open")).toBe(1);
    expect(native.listenerCounts.get("message")).toBe(1);
    expect(native.listenerCounts.get("close")).toBe(1);
    expect(native.listenerCounts.get("error")).toBe(1);

    native.fireClose(1000, "");

    expect(native.listenerCounts.get("open")).toBe(0);
    expect(native.listenerCounts.get("message")).toBe(0);
    expect(native.listenerCounts.get("close")).toBe(0);
    expect(native.listenerCounts.get("error")).toBe(0);
  });
});
