import { schema } from "@factory/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { type SubmitRunDeps, submitRun } from "./submit.ts";

const TICK_MS = 60_000;

/**
 * Resume runs halted by a usage cap once their reset time has passed.
 *
 * A `usage_capped` run with `resume_at` set is scheduled for automatic
 * resumption: at/after that epoch-ms the daemon submits a continuation run
 * that reuses the capped run's worktree + Claude session (`reuseFromRunId`),
 * so the agent picks up where the quota cut it off instead of restarting.
 *
 * Idempotent and restart-safe: the schedule lives on the run row, so a
 * daemon restart re-discovers due runs on the next tick. `resume_at` is
 * cleared the moment a continuation is submitted, so each cap resumes once.
 * Runs that re-cap or had no parseable reset time never get a `resume_at` —
 * the runner surfaces those as `blocked_run` decisions instead.
 */
export function startUsageCapResumer(deps: SubmitRunDeps): () => void {
  const { db } = deps;

  async function tick(): Promise<void> {
    const due = await db
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        taskId: schema.runs.taskId,
      })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.status, "usage_capped"),
          isNotNull(schema.runs.resumeAt),
          lte(schema.runs.resumeAt, Date.now()),
        ),
      )
      .all();

    for (const run of due) {
      // Clear the schedule before submitting so a slow submit can't be
      // double-resumed on the next tick. The capped run row stays
      // `usage_capped` as history; the continuation carries the work forward.
      await db.update(schema.runs).set({ resumeAt: null }).where(eq(schema.runs.id, run.id));
      try {
        const { runId } = await submitRun(deps, {
          projectId: run.projectId,
          taskId: run.taskId ?? undefined,
          reuseFromRunId: run.id,
        });
        console.log(`[usage-cap] resumed capped run ${run.id} → ${runId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[usage-cap] failed to resume ${run.id}: ${msg}`);
      }
    }
  }

  // Run once on start so a daemon that booted after a reset time elapsed
  // doesn't wait a full tick, then settle into the interval.
  void tick();
  const handle = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(handle);
}
