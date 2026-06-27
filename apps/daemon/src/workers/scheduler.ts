import type { EventBus } from "../events.ts";

/**
 * The Watch scheduler (ADR-010 §1) — the third daemon tick, alongside
 * `usage-cap.ts` and `inbox-resurface.ts`. It drives a registry of jobs:
 * time-cadence jobs (run when due) and event jobs (run on an EventBus kind).
 * Generic by design — callers supply the jobs; the scheduler owns only the
 * tick, the due math, and the skip-if-inflight guard.
 *
 * Advisory by construction: jobs produce inbox items, never side effects, so a
 * missed or skipped run is never a correctness problem.
 */

export type Cadence = "off" | "hourly" | "daily" | "weekly";

export const CADENCES: readonly Cadence[] = ["off", "hourly", "daily", "weekly"] as const;

const CADENCE_MS: Record<Exclude<Cadence, "off">, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export function cadenceMs(c: Cadence): number {
  return c === "off" ? Number.POSITIVE_INFINITY : CADENCE_MS[c];
}

export function isCadence(v: string): v is Cadence {
  return (CADENCES as readonly string[]).includes(v);
}

export interface ScheduledJob {
  id: string;
  /**
   * Resolved per-tick (a thunk) so it can read live settings — the operator can
   * retune cadence without a restart. Omit for event-only jobs.
   */
  cadence?: () => Cadence;
  /** DaemonEvent `kind`s that also trigger this job. */
  events?: ReadonlySet<string>;
  run(): Promise<void>;
}

export interface SchedulerDeps {
  events: EventBus;
  jobs: ScheduledJob[];
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Tick interval. Defaults to 60s. */
  tickMs?: number;
}

export interface SchedulerHandle {
  stop: () => void;
  /** Run all due time-cadence jobs as of `at` (exposed for deterministic tests). */
  runDue: (at: number) => void;
}

const DEFAULT_TICK_MS = 60_000;

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const lastRun = new Map<string, number>();
  const inflight = new Set<string>();

  // Seed time-cadence jobs to "now" so they first fire one full interval after
  // boot — not on every restart (synthesis is token-intensive). Durable last-run
  // that survives restarts lands with `watch_cursors` in slice 3.
  const start = now();
  for (const job of deps.jobs) if (job.cadence) lastRun.set(job.id, start);

  function runJob(job: ScheduledJob, at: number): void {
    if (inflight.has(job.id)) return; // skip-if-inflight
    inflight.add(job.id);
    lastRun.set(job.id, at);
    void job
      .run()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[scheduler] job ${job.id} failed: ${msg}`);
      })
      .finally(() => inflight.delete(job.id));
  }

  function runDue(at: number): void {
    for (const job of deps.jobs) {
      if (!job.cadence) continue;
      const c = job.cadence();
      if (c === "off") continue;
      const last = lastRun.get(job.id) ?? 0;
      if (at - last >= cadenceMs(c)) runJob(job, at);
    }
  }

  const unsub = deps.events.subscribe((e) => {
    const kind = (e as { kind?: string }).kind;
    if (!kind) return;
    for (const job of deps.jobs) if (job.events?.has(kind)) runJob(job, now());
  });

  const timer = setInterval(() => runDue(now()), tickMs);
  return {
    stop: () => {
      clearInterval(timer);
      unsub();
    },
    runDue,
  };
}
