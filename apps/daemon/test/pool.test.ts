import { describe, expect, spyOn, test } from "bun:test";
import { WorkerPool } from "../src/workers/pool.ts";

describe("WorkerPool · pre-task-handling throw isolation", () => {
  test("a task that throws before its own handling is logged, and the pool keeps going", async () => {
    const pool = new WorkerPool(1);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran: string[] = [];

      // First task throws immediately — simulating a throw in the submit
      // wrapper before executeRun's own error handling begins.
      const first = pool.submit(
        async () => {
          throw new Error("boom: before executeRun handling");
        },
        { label: "run-boom" },
      );

      // Second task must still run — the pool loop survives the first throw.
      const second = pool.submit(async () => {
        ran.push("second");
      });

      // Neither submit rejects: the pool swallows (but logs) the failure.
      await expect(first).resolves.toBeUndefined();
      await second;

      expect(ran).toEqual(["second"]);

      // The error was logged at error level, attributed to the run label.
      expect(errorSpy).toHaveBeenCalled();
      const call = errorSpy.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("run-boom"),
      );
      expect(call).toBeTruthy();
      // The Error itself is passed through, not swallowed.
      expect(call?.some((a) => a instanceof Error && /boom/.test(a.message))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      await pool.drain();
    }
  });
});

describe("WorkerPool · bounded concurrency", () => {
  test("with concurrency N, never runs more than N tasks at once, and the queue fully drains", async () => {
    const N = 3;
    const total = N + 2; // submit N+2 so N tasks run and 2 must queue
    const pool = new WorkerPool(N);

    let active = 0;
    let maxActive = 0;
    const finished: number[] = [];
    // A barrier every task parks on, so we can observe the scheduler's placement
    // (N active, the rest queued) before letting anything complete.
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });

    const promises = Array.from({ length: total }, (_, i) =>
      pool.submit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await barrier;
        active--;
        finished.push(i);
      }),
    );

    // `submit` starts the first N tasks synchronously (up to their first await),
    // so immediately after issuing every submit the pool is saturated at N and
    // the remaining tasks are parked in the queue.
    expect(pool.size()).toEqual({ active: N, queued: total - N });
    expect(maxActive).toBe(N);

    release();
    await Promise.all(promises);

    // Every submitted task eventually executed; concurrency never exceeded N.
    expect(maxActive).toBe(N);
    expect(finished.length).toBe(total);
    expect(new Set(finished)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(pool.size()).toEqual({ active: 0, queued: 0 });
  });

  test("a throwing task does not stop subsequent queued tasks from running", async () => {
    const pool = new WorkerPool(2);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran: number[] = [];
      // Even-indexed tasks throw before their own handling; odd-indexed record.
      const promises = Array.from({ length: 6 }, (_, i) =>
        pool.submit(
          async () => {
            if (i % 2 === 0) throw new Error(`boom-${i}`);
            ran.push(i);
          },
          { label: `t-${i}` },
        ),
      );

      // No submit rejects — the pool swallows (and logs) each throw and keeps draining.
      await expect(Promise.all(promises)).resolves.toHaveLength(6);
      expect(ran.sort((a, b) => a - b)).toEqual([1, 3, 5]);
      expect(pool.size()).toEqual({ active: 0, queued: 0 });
    } finally {
      errorSpy.mockRestore();
      await pool.drain();
    }
  });
});
