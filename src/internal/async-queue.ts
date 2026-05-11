// Simple bounded async queue used by the streaming client to bridge ws
// callbacks to an async iterator. push() either resolves a pending waiter or
// buffers; iteration awaits on next() until a value arrives or the queue
// is closed (with optional terminal error).

export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private closed = false;
  private error: unknown = undefined;

  /** Push a value to consumers. Ignored after close(). */
  push(value: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) {
      // Pair off any pending rejecter — it will never fire for this slot now.
      this.rejecters.shift();
      w({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  /**
   * Mark the queue done.
   *
   * - close() (no error): buffered values drain to consumers first, then
   *   subsequent next() calls resolve with `done: true`.
   * - close(error): buffer is discarded; pending and subsequent next() calls
   *   reject with the error immediately. Use this for terminal failures
   *   (e.g. WS connection died) where stale buffered events would mislead.
   */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    if (error !== undefined) {
      this.buffer.length = 0;
      while (this.rejecters.length) this.rejecters.shift()!(error);
      this.waiters.length = 0;
      return;
    }
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
    this.rejecters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Terminal error wins over any buffered values — fail fast on close(error).
        if (this.closed && this.error !== undefined) {
          return Promise.reject(this.error);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        // Iterator protocol: return() signals the consumer is done. Drop
        // any buffered values; subsequent next() calls report done.
        this.buffer.length = 0;
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}
