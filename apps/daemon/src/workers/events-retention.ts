import { type Db, schema } from "@factory/db";
import { and, count, inArray, isNotNull, lte } from "drizzle-orm";
import type { ScheduledJob } from "./scheduler.ts";

/**
 * Run statuses whose events are eligible for retention sweeps. Deliberately an
 * ALLOWLIST, not a blocklist: only these three states are considered terminal
 * for the purpose of aging out events. Everything else — `queued`, `running`,
 * `blocked`, `deferred`, `usage_capped`, `needs_review` — is left untouched
 * regardless of age, because those runs can still resume, be resumed, or be
 * acted on by the operator.
 */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "aborted"] as const;

/** Default retention window, mirrored in config.ts (`eventRetentionDays`). */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventsRetentionOptions {
  /**
   * Age threshold in days. Events for terminal runs whose `endedAt` is more
   * than this many days ago are deleted. `<= 0` disables the sweep (a no-op
   * returning 0) — the retention window would otherwise be "now", which would
   * delete events the moment a run finishes.
   */
  retentionDays: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Delete `events` rows belonging to runs in a terminal state (completed /
 * failed / aborted) whose run ended more than `retentionDays` ago. Returns the
 * number of event rows deleted.
 *
 * Age is measured from the run's `endedAt` (the terminal timestamp), so a run's
 * events age out together. The delete is gated on `TERMINAL_RUN_STATUSES`, so
 * events for non-terminal runs are never touched no matter how old. The `runId`
 * filter uses a correlated subquery (not a bound id list), so the sweep scales
 * past SQLite's bound-parameter limit on busy installs.
 */
export function sweepExpiredEvents(db: Db, opts: EventsRetentionOptions): number {
  if (opts.retentionDays <= 0) return 0;
  const now = opts.now ?? Date.now;
  const cutoff = now() - opts.retentionDays * DAY_MS;

  // `isNotNull(endedAt)` guards the epoch-0 fallback: a terminal-but-endedAt-
  // null row (shouldn't happen) must not sweep on `lte(null-as-0, cutoff)`.
  const expiredRunIds = db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        inArray(schema.runs.status, [...TERMINAL_RUN_STATUSES]),
        isNotNull(schema.runs.endedAt),
        lte(schema.runs.endedAt, cutoff),
      ),
    );

  // Count before deleting (drizzle's delete `.run()` doesn't surface a row
  // count here). Both the count and the delete filter on the same correlated
  // subquery, so they see the same set within this synchronous call.
  const [row] = db
    .select({ n: count() })
    .from(schema.events)
    .where(inArray(schema.events.runId, expiredRunIds))
    .all();
  const n = row?.n ?? 0;
  if (n === 0) return 0;

  db.delete(schema.events).where(inArray(schema.events.runId, expiredRunIds)).run();
  return n;
}

/**
 * Daily retention sweep for the Watch scheduler substrate. Fixed `daily`
 * cadence, DB-only (no LLM), durable last-run via the scheduler store so it
 * survives the daemon's frequent restarts (copying the fix in scheduler.ts,
 * not the old boot-reset bug). Purely janitorial: it logs one line per sweep
 * with the delete count and never surfaces an inbox card.
 */
export function createEventsRetentionJob(db: Db, retentionDays: number): ScheduledJob {
  return {
    id: "events-retention",
    cadence: () => "daily",
    async run() {
      const deleted = sweepExpiredEvents(db, { retentionDays });
      console.log(
        `[events-retention] swept ${deleted} event row(s) for terminal runs older than ${retentionDays}d`,
      );
    },
  };
}
