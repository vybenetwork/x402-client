import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../src/internal/async-queue.js";

describe("AsyncQueue", () => {
  it("yields buffered values in order", async () => {
    const q = new AsyncQueue<number>();
    q.push(1); q.push(2); q.push(3);
    q.close();

    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("resolves a pending waiter when push happens after next() is awaited", async () => {
    const q = new AsyncQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push(42);
    const r = await pending;
    expect(r).toEqual({ value: 42, done: false });
  });

  it("close() ends iteration without error", async () => {
    const q = new AsyncQueue<number>();
    q.close();
    const it = q[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(true);
  });

  it("close(error) rejects pending waiters with the error", async () => {
    const q = new AsyncQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    const err = new Error("boom");
    q.close(err);
    await expect(pending).rejects.toBe(err);
  });

  it("buffered values still emit after close() with no error", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it("return() ends iteration cleanly even if values are buffered", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const it = q[Symbol.asyncIterator]();
    await it.return!();
    const next = await it.next();
    expect(next.done).toBe(true);
  });

  it("push after close is a no-op", async () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.push(99);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
