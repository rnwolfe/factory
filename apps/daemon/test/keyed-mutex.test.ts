import { describe, expect, test } from "bun:test";

import { KeyedMutex } from "../src/workers/keyed-mutex.ts";

/**
 * `isHeld` is the contention signal the runner reads before it acquires the
 * per-project merge lock: a `true` return means this run is about to WAIT behind
 * another same-project merge, so it surfaces a "waiting to merge" indicator.
 * These tests pin that behaviour — true while a section holds/queues the key,
 * false once the chain drains, and never cross-contaminating between keys.
 */
describe("KeyedMutex.isHeld", () => {
  test("false for an untouched key", () => {
    const m = new KeyedMutex();
    expect(m.isHeld("nope")).toBe(false);
  });

  test("true while a section is executing, false after it drains", async () => {
    const m = new KeyedMutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const running = m.run("k", async () => {
      await gate;
      return "done";
    });

    // fn is in flight (awaiting the gate) — the key is held.
    expect(m.isHeld("k")).toBe(true);

    release();
    await running;
    // Let the tail's cleanup microtask (delete) run.
    await Promise.resolve();
    await Promise.resolve();
    expect(m.isHeld("k")).toBe(false);
  });

  test("held while a second caller is queued behind the first", async () => {
    const m = new KeyedMutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];

    const first = m.run("k", async () => {
      await gate;
      order.push("first");
    });
    // Second caller queues behind first — the key is contended right now, which
    // is exactly the state the runner detects to emit `merge_waiting`.
    expect(m.isHeld("k")).toBe(true);
    const second = m.run("k", async () => {
      order.push("second");
    });
    expect(m.isHeld("k")).toBe(true);

    release();
    await Promise.all([first, second]);
    await Promise.resolve();
    await Promise.resolve();
    expect(m.isHeld("k")).toBe(false);
    // Ordering preserved (FIFO).
    expect(order).toEqual(["first", "second"]);
  });

  test("keys don't cross-contaminate", async () => {
    const m = new KeyedMutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const running = m.run("a", async () => {
      await gate;
    });
    expect(m.isHeld("a")).toBe(true);
    // A different project's merge lock is untouched — it still merges concurrently.
    expect(m.isHeld("b")).toBe(false);

    release();
    await running;
  });
});
