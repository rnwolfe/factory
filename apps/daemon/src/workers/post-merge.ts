import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { listTasks, pickNextReadyTask, readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import type { WorkerPool } from "./pool.ts";
import type { RunRegistry } from "./registry.ts";

type RunStatus = (typeof schema.runStatusEnum)[number];
type TaskStatus = (typeof schema.taskStatusEnum)[number];

/**
 * Single source of truth mapping a terminal run status onto the task status
 * the run's task should land in. `runner.ts` writes this pre-merge into the
 * run's worktree (so the value rides the merge commit back to main).
 * `decisions.ts` and `interventions/orchestrate.ts` invoke it post-merge as
 * a defensive re-apply for paths where the operator may have manually
 * resolved a conflict that overwrote the run's task-status commit.
 */
export function taskStatusFor(runStatus: RunStatus): TaskStatus {
  switch (runStatus) {
    case "completed":
      return "done";
    case "aborted":
      return "ready";
    case "blocked":
      return "blocked";
    default:
      return "blocked";
  }
}

export interface PostMergeDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

/**
 * Run after a successful merge-into-main for a given run — whether the merge
 * succeeded on the runner's first attempt or via an operator-approved retry
 * (merge_failure decision approve, or merge_failure intervention resume).
 *
 * Two side-effects, both idempotent:
 *
 *   1. Defensive task-status reconcile. The runner's pre-merge worktree
 *      commit normally rides the merge to main and stamps the task file.
 *      But if the operator resolved a conflict by hand and picked main's
 *      version, the status on main can lag the run row. We read what's on
 *      main, compare against `taskStatusFor(run.status)`, write+commit only
 *      on mismatch. Happy path: no-op.
 *
 *   2. Auto-advance. The runner holds auto-advance on a merge failure (the
 *      next task would start from a main missing this run's work). After
 *      the operator-approved merge lands, the held advance fires here.
 *      Guarded by a check for any other queued/running run on the project,
 *      so an operator-submitted follow-up doesn't get doubled.
 *
 * Only fires for `completed` runs. Blocked/failed/aborted runs leave the
 * task in a non-terminal state and shouldn't trigger auto-advance.
 */
export async function applyPostMergeRunOutcome(deps: PostMergeDeps, runId: string): Promise<void> {
  const { config, db, events, runs, pool } = deps;

  const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!run) return;
  if (run.status !== "completed") return;

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();
  if (!project) return;

  // Task-status reconcile. Only runs with an associated task have one to
  // reconcile; ad-hoc runs (taskId null) skip this entirely.
  if (run.taskId) {
    try {
      const target = taskStatusFor(run.status);
      const onMain = await readTaskFile(project.workdirPath, run.taskId);
      if (onMain && onMain.frontmatter.status !== target) {
        const updated = await updateTaskStatus(project.workdirPath, run.taskId, target);
        if (updated) {
          await commitAllChanges(
            project.workdirPath,
            `chore: ${run.taskId} status -> ${updated.frontmatter.status}`,
            config.gitAuthor,
          );
        }
      }
    } catch {
      // task file may be missing on main (e.g. operator deleted it during
      // intervention). Don't fail the whole post-merge path — auto-advance
      // can still fire on the remaining ready tasks.
    }
  }

  // Auto-advance. Guarded against a double-fire: if another run on the
  // same project is already queued or running, the operator (or a prior
  // helper invocation) has already advanced. Exclude the current runId
  // from the check — at the moment this helper runs from the runner's
  // happy path the row is already `completed`, but on the
  // merge_failure-approve path the row was never re-queried so we're
  // safe either way.
  if (project.autoAdvance) {
    const others = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, project.id),
          inArray(schema.runs.status, ["queued", "running"]),
          ne(schema.runs.id, runId),
        ),
      )
      .all();
    if (others.length === 0) {
      const tasks = await listTasks(project.workdirPath);
      // Use `pickNextReadyTask` (not `tasks.find`) so auto-advance respects
      // the operator's starting point and doesn't wrap back to an earlier
      // task — the v0.9.4 ordering fix. Picks the next ready task with an
      // id after `run.taskId`; stops if nothing later is ready.
      const next = pickNextReadyTask(tasks, run.taskId);
      if (next) {
        // Dynamic import to break the cycle: submit.ts → runner.ts (via
        // executeRun), and runner.ts imports this module.
        const { submitRun } = await import("./submit.ts");
        await submitRun(
          { config, db, events, runs, pool },
          { projectId: project.id, taskId: next.id },
        );
      }
    }
  }
}
