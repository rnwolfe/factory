/**
 * Bounded retry for the out-of-run headless agent invocations (`claude --print`
 * and codex equivalents). These calls are read-only — no worktree, no commits,
 * no side effects on the repo — so a transient process-level failure (spawn
 * error, dropped stream, CLI crash, empty output) is safe to re-roll.
 *
 * The one thing we deliberately do NOT retry is a JSON-parse failure. Parsing
 * happens in the *callers* (triage's `extractJson`, audits' `parseAuditResponse`,
 * feedback/plans' `extractJsonObject`) — after the invoker has already returned
 * successfully — so a malformed-JSON turn never enters this loop at all. That is
 * intentional: the null-parse-fail discipline (see the factory-status contract
 * in CLAUDE.md) keeps a model honest. A model that returned garbage should fail
 * the turn visibly, not get silently re-rolled.
 *
 * To keep the classification precise, only `TransientInvokeError` is retried.
 * The single-attempt invoker throws it for the process-level failures listed
 * above; anything else (e.g. a `ResumeUnsupportedError`, a programming bug)
 * propagates on the first attempt.
 */

/**
 * Marks a process-level, safe-to-retry failure of a headless agent invocation:
 * spawn error, non-zero exit with no output, empty output where output was
 * expected, or a stream/pipe error. Distinct from parse failures, which are
 * never wrapped in this type and never retried.
 */
export class TransientInvokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientInvokeError";
  }
}

export interface InvokeRetryOptions {
  /** Total attempts including the first. Default 3 (i.e. 2 retries). */
  maxAttempts?: number;
  /**
   * Backoff before each retry, indexed by the just-failed attempt number − 1.
   * Default [2000, 8000] → 2s before attempt 2, 8s before attempt 3. Short by
   * design: the operator is often waiting on these turns interactively.
   */
  backoffMs?: number[];
  /** Short label for log lines (e.g. "claude-code plan iteration"). */
  label?: string;
  /** Injectable logger. Default `console.warn`. */
  log?: (message: string) => void;
  /** Injectable sleep. Default `setTimeout`-based. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` up to `maxAttempts` times, retrying only when it throws a
 * `TransientInvokeError`. Any other error propagates immediately (not retried).
 * Each retry is logged with the path label, attempt number, and error.
 */
export async function withInvokeRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  opts: InvokeRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? [2000, 8000];
  const log = opts.log ?? ((m: string) => console.warn(m));
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof TransientInvokeError;
      if (!retryable || n >= maxAttempts) throw err;
      const wait = backoffMs[n - 1] ?? backoffMs.at(-1) ?? 0;
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 160);
      log(
        `[invoke-retry]${opts.label ? ` ${opts.label}` : ""} attempt ${n}/${maxAttempts} failed transiently: ${detail} — retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  // Unreachable: the loop either returns or throws. Rethrow defensively.
  throw lastError;
}
