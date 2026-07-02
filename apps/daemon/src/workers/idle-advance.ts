import { type Db, schema } from "@factory/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import { listTasks, pickNextReadyTask } from "../projects/tasks.ts";
import { type SubmitRunDeps, submitRun } from "./submit.ts";

const TICK_MS = 60_000;

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
    // (a) An in-flight run — preserves auto-advance's one-run-per-project
    // invariant and prevents double-submission across ticks.
    const inFlight = db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, project.id),
          inArray(schema.runs.status, ["queued", "running"]),
        ),
      )
      .limit(1)
      .all();
    if (inFlight.length > 0) continue;

    // (b) An UNRESOLVED held/blocked/failed run — surfaced as a pending
    // `blocked_run` decision. This is the correct live signal: `needs_review`
    // and `blocked` RUN rows persist as history forever, so keying on run status
    // would block a project permanently after its first hold. The pending
    // decision clears when the operator resolves it. This is what stops the
    // futile re-run loop of a gate-held task whose status is still `ready`.
    const awaitingOperator = db
      .select({ id: schema.decisions.id })
      .from(schema.decisions)
      .where(
        and(
          eq(schema.decisions.projectId, project.id),
          eq(schema.decisions.kind, "blocked_run"),
          eq(schema.decisions.status, "pending"),
        ),
      )
      .limit(1)
      .all();
    if (awaitingOperator.length > 0) continue;

    // (c) A usage-capped run awaiting scheduled resume — don't cold-start into a
    // cap; the usage-cap resumer will continue it. `resumeAt` is the live signal
    // (cleared on resume), so this never permanently blocks.
    const capped = db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, project.id),
          eq(schema.runs.status, "usage_capped"),
          isNotNull(schema.runs.resumeAt),
        ),
      )
      .limit(1)
      .all();
    if (capped.length > 0) continue;

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
