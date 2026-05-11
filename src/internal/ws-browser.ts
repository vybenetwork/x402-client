// Browser shim for the `ws` package. Wraps the platform's native WebSocket
// in an adapter that exposes the EventEmitter-style `.on(event, cb)` API
// the SDK's WebSocket code uses, so the browser bundle works without any
// call-site changes.
//
// Native WebSocket is EventTarget-based (addEventListener). The adapter
// translates between the two and normalizes payloads so the SDK sees the
// same `(raw)`, `(code, reason)`, `(err)` shapes it gets from Node `ws`.

type Listener = (...args: unknown[]) => void;

class BrowserWebSocketAdapter {
  private ws: WebSocket;
  private listeners = new Map<string, Set<Listener>>();
  private detached = false;
  // Stored handlers so close() can detach them from the native socket.
  // Without this, an adapter that's GC'd mid-stream leaves native-WS
  // listeners alive, preventing the underlying WebSocket from being
  // collected and (in long-lived pages) accumulating per stream.
  private nativeOpen = (): void => this.emit("open");
  private nativeMessage = (ev: MessageEvent): void => {
    const data = typeof ev.data === "string" ? ev.data : String(ev.data);
    this.emit("message", data);
  };
  private nativeClose = (ev: CloseEvent): void => {
    this.emit("close", ev.code, ev.reason ?? "");
    this.detach();
  };
  // Don't detach() on error — the WebSocket spec guarantees a `close`
  // event always follows `error`, and the close handler does the cleanup.
  // Detaching here would swallow the close event before it reaches the
  // SDK's onclose handler, which the SDK relies on to surface the
  // close-code-mapped error to the user.
  private nativeError = (): void => this.emit("error", new Error("WebSocket error"));

  constructor(url: string) {
    this.ws = new WebSocket(url);
    // The API only sends JSON text frames; force ArrayBuffer for the
    // accidental binary frame so we can stringify uniformly.
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", this.nativeOpen);
    this.ws.addEventListener("message", this.nativeMessage);
    this.ws.addEventListener("close", this.nativeClose);
    this.ws.addEventListener("error", this.nativeError);
  }

  on(event: string, cb: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return this;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(...args);
  }

  /** Remove native-WS listeners and clear our user-listener registry. Idempotent. */
  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.ws.removeEventListener("open", this.nativeOpen);
    this.ws.removeEventListener("message", this.nativeMessage);
    this.ws.removeEventListener("close", this.nativeClose);
    this.ws.removeEventListener("error", this.nativeError);
    this.listeners.clear();
  }
}

export default BrowserWebSocketAdapter;
export { BrowserWebSocketAdapter as WebSocket };
