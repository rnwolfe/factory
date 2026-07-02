import { type Db, schema } from "@factory/db";
import { and, eq, inArray } from "drizzle-orm";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import { listTasks, pickNextReadyTask } from "../projects/tasks.ts";
import { type SubmitRunDeps, submitRun } from "./submit.ts";

const TICK_MS = 60_000;

/**
 * Run statuses that make a project NOT idle-eligible for cold-start. Beyond the
 * obviously in-flight (`queued`/`running`), these are all "the operator or the
 * system still owes this run an action": a `needs_review` hold, a self-`blocked`
 * run, a `usage_capped` run awaiting resume, or a `deferred` one. Cold-starting
 * over any of them re-runs work that's legitimately paused — most dangerously,
 * re-submitting a gate-held task whose status is still `ready` in an endless
 * futile loop (the schema-task hold that motivated this guard). Auto-advance
 * already naturally stops at a held run (no merge → no chain); this mirrors it.
 */
const UNRESOLVED_RUN_STATUSES = [
  "queued",
  "running",
  "needs_review",
  "blocked",
  "usage_capped",
  "deferred",
] as const;

export interface IdleColdStart {
  projectId: string;
  taskId: string;
}

/**
 * Which idle autonomous projects have a ready task to cold-start (ADR-022).
 *
 * Pure read (no submit) so it's testable in isolation. A project is eligible
 * when it is at the top trust rung (`autonomous`), has auto-advance on, is
 * active (not archived), has NO run in flight (queued/running), and has a
 * startable ready task. Honors the portfolio + per-project emergency-stop.
 */
export async function collectIdleColdStarts(db: Db): Promise<IdleColdStart[]> {
  const out: IdleColdStart[] = [];
  // Portfolio kill-switch (shared with Phase-C auto-run).
  if (resolveAutonomyConfig(db).autorun.emergencyStop) return out;

  const projects = db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.autoAdvance, true),
        eq(schema.projects.autonomyMode, "autonomous"),
        eq(schema.projects.tag, "active"),
      ),
    )
    .all();

  for (const project of projects) {
    // Never cold-start over unresolved work — in-flight OR awaiting the
    // operator (held/blocked/capped). This preserves auto-advance's
    // one-run-per-project invariant, prevents double-submission across ticks,
    // and — critically — stops re-running a gate-held task whose status is
    // still `ready` in a futile loop.
    const unresolved = db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, project.id),
          inArray(schema.runs.status, [...UNRESOLVED_RUN_STATUSES]),
        ),
      )
      .all();
    if (unresolved.length > 0) continue;

    // Per-project emergency stop (resolved through the full config chain).
    if (resolveAutonomyConfig(db, project.id).autorun.emergencyStop) continue;

    const tasks = await listTasks(project);
    // Cold start = no anchor: the first startable ready task in queue order.
    // From there the existing post-merge chain (post-merge.ts) takes over.
    const next = pickNextReadyTask(tasks, null);
    if (next) out.push({ projectId: project.id, taskId: next.id });
  }
  return out;
}

/**
 * Cold-start / resume auto-advance for IDLE autonomous projects (ADR-022).
 *
 * Auto-advance only chains post-merge, so an autonomous project whose chain was
 * interrupted — a daemon restart, a dismissed merge failure, or one that simply
 * never had a first run kicked off — sits on a queue of ready tasks with nothing
 * running. This tick closes that gap: once per minute it submits the next ready
 * task for each eligible idle project; the existing post-merge chain then carries
 * it forward. Restart-safe by construction (all state is the runs table).
 */
export function startIdleAutoAdvancer(deps: SubmitRunDeps): () => void {
  const { db } = deps;

  async function tick(): Promise<void> {
    let candidates: IdleColdStart[];
    try {
      candidates = await collectIdleColdStarts(db);
    } catch (err) {
      console.warn(`[idle-advance] scan failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const c of candidates) {
      try {
        const { runId } = await submitRun(deps, { projectId: c.projectId, taskId: c.taskId });
        console.log(`[idle-advance] cold-started ${c.projectId} → task ${c.taskId} (run ${runId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[idle-advance] failed to start ${c.projectId}/${c.taskId}: ${msg}`);
      }
    }
  }

  // Fire once on boot so an interrupted chain resumes promptly (not a full tick
  // later), then settle into the interval.
  void tick();
  const handle = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(handle);
}
