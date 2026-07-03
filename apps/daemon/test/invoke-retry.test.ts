import { describe, expect, test } from "bun:test";
import { TransientInvokeError, withInvokeRetry } from "../src/plans/invoke-retry.ts";

const noSleep = async () => {};

describe("withInvokeRetry", () => {
  test("transient failure once, then success → completes with a logged retry", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const sleeps: number[] = [];

    const result = await withInvokeRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new TransientInvokeError("spawn error: EPIPE");
        return { text: "ok" };
      },
      {
        label: "claude-code plan iteration",
        log: (m) => logs.push(m),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toEqual({ text: "ok" });
    expect(attempts).toBe(2);
    // Exactly one retry was logged, naming the path and the attempt number.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("claude-code plan iteration");
    expect(logs[0]).toContain("attempt 1/3");
    expect(logs[0]).toContain("EPIPE");
    // Default backoff before the second attempt is 2s.
    expect(sleeps).toEqual([2000]);
  });

  test("non-transient (parse-shaped) failure is NOT retried and propagates", async () => {
    let attempts = 0;
    const logs: string[] = [];

    await expect(
      withInvokeRetry(
        async () => {
          attempts++;
          // A JSON-parse failure surfaces as a plain Error, never a
          // TransientInvokeError — so it must fail the turn on the first try.
          throw new Error("Unexpected token < in JSON at position 0");
        },
        { log: (m) => logs.push(m), sleep: noSleep },
      ),
    ).rejects.toThrow("Unexpected token");

    expect(attempts).toBe(1);
    expect(logs).toHaveLength(0);
  });

  test("retries are bounded to 3 attempts (2 retries), then the error propagates", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const sleeps: number[] = [];

    await expect(
      withInvokeRetry(
        async () => {
          attempts++;
          throw new TransientInvokeError(`crash on attempt ${attempts}`);
        },
        {
          log: (m) => logs.push(m),
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow(TransientInvokeError);

    expect(attempts).toBe(3);
    // Two retries logged (before attempts 2 and 3); the third failure throws.
    expect(logs).toHaveLength(2);
    // Short exponential backoff: 2s, then 8s.
    expect(sleeps).toEqual([2000, 8000]);
  });

  test("custom maxAttempts and backoff are honored", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    await expect(
      withInvokeRetry(
        async () => {
          attempts++;
          throw new TransientInvokeError("nope");
        },
        {
          maxAttempts: 2,
          backoffMs: [50],
          log: () => {},
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow(TransientInvokeError);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([50]);
  });
});
