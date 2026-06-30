import { type Db, schema } from "@factory/db";
import type { SchedulerStore } from "./scheduler.ts";

/**
 * Durable last-run store for the scheduler, backed by the `scheduler_runs`
 * table. Mirrors `createDbCursorStore`. Persisting last-run is what makes a
 * `daily` job fire on a host that restarts many times a day (without it the
 * in-memory clock reset to boot every restart and the job never came due —
 * the reason The Watch never synthesized in prod).
 */
export function createDbSchedulerStore(db: Db): SchedulerStore {
  return {
    load() {
      const rows = db.select().from(schema.schedulerRuns).all();
      return new Map(rows.map((r) => [r.jobId, r.lastRun]));
    },
    save(jobId, at) {
      db.insert(schema.schedulerRuns)
        .values({ jobId, lastRun: at })
        .onConflictDoUpdate({ target: schema.schedulerRuns.jobId, set: { lastRun: at } })
        .run();
    },
  };
}
