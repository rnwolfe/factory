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
