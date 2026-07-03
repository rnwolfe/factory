import type { Db, Project } from "@factory/db";
import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { and, eq, inArray, ne } from "drizzle-orm";
import { matchingAutonomyPreset, resolveAutonomyConfig } from "../autonomy/config.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { InvokeClaudeResult } from "../plans/invoke-claude.ts";
import {
  listTasks,
  maybeAutoCloseEpics,
  pickNextReadyTask,
  readTaskFile,
  taskStoreFor,
  updateTaskStatus,
} from "../projects/tasks.ts";
import { KeyedMutex } from "./keyed-mutex.ts";
import type { WorkerPool } from "./pool.ts";
import type { RunRegistry } from "./registry.ts";

type RunStatus = (typeof schema.runStatusEnum)[number];
type TaskStatus = (typeof schema.taskStatusEnum)[number];

/**
 * Serializes the auto-advance check-then-submit per project. Module-level so
 * every `applyPostMergeRunOutcome` invocation (runner finalize, merge_failure
 * approve, intervention resume) shares one lock keyed by projectId. Two runs on
 * the same project finalizing concurrently would otherwise both see "no other
 * active runs" and both submit the same next ready task → duplicate run.
 */
const autoAdvanceLock = new KeyedMutex();

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
  /**
   * Test/override seam for the hands-off auto-plan path — forwarded to
   * `proposeMilestone`. Omitted in production so the real agent runs.
   */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
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
      const onMain = await readTaskFile(project, run.taskId);
      if (onMain && onMain.frontmatter.status !== target) {
        const updated = await updateTaskStatus(project, run.taskId, target);
        // github-backed: updateTaskStatus already PATCHed the issue; there's no
        // local file to commit, so skip the (empty) reconcile commit + its
        // misleading "gitignored" warning.
        if (updated && project.taskBackend !== "github-issues") {
          const committed = await commitAllChanges(
            project.workdirPath,
            `chore: ${run.taskId} status -> ${updated.frontmatter.status}`,
            config.gitAuthor,
          );
          // Same gitignore trap as runner.ts: we wrote the file but the
          // commit was empty, so the reconcile won't actually land. Warn
          // loudly — silent no-ops here stranded 7 tasks at `ready` before
          // .factory/work/ was unignored on this project.
          if (!committed) {
            console.warn(
              `[post-merge] reconcile commit was empty for ${run.taskId} in ${project.workdirPath} — .factory/work/ likely gitignored on this project; task status will stay at ${onMain.frontmatter.status} on main`,
            );
          }
        }
      }
    } catch {
      // task file may be missing on main (e.g. operator deleted it during
      // intervention). Don't fail the whole post-merge path — auto-advance
      // can still fire on the remaining ready tasks.
    }
    // Epic rollup (ADR-023): a completed run may have closed the last open child
    // of an epic — auto-close the epic when the operator opted in. Best-effort;
    // never blocks auto-advance.
    try {
      if (
        taskStatusFor(run.status) === "done" &&
        resolveAutonomyConfig(db, project.id).hierarchy.epicAutoClose
      ) {
        const closed = await maybeAutoCloseEpics(taskStoreFor(project));
        // File backend writes the epic's task file locally; commit it so the
        // worktree doesn't go dirty on main (which would break the next
        // mergeIntoMain). github-issues closes the issue remotely — nothing local.
        if (closed.length > 0 && project.taskBackend !== "github-issues") {
          await commitAllChanges(
            project.workdirPath,
            `chore: auto-close epic(s) ${closed.join(", ")}`,
            config.gitAuthor,
          );
        }
      }
    } catch {
      // hierarchy read/close is enrichment — swallow and continue.
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
    // Hold a per-project lock across the ENTIRE check-then-submit sequence.
    // bun:sqlite statements are individually atomic, but this logical
    // "any other active runs? → pick next → submit" chain is not: without the
    // lock, two concurrent finalizations both read zero active runs and both
    // submit the same next task (worker-pool concurrency makes this window
    // real). The lock is held only across the check + submit, never across the
    // run's execution.
    await autoAdvanceLock.run(project.id, async () => {
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
      if (others.length > 0) return;

      const tasks = await listTasks(project);
      // Use `pickNextReadyTask` (not `tasks.find`) so auto-advance respects
      // the operator's starting point and doesn't wrap back to an earlier
      // task — the v0.9.4 ordering fix. Picks the next ready task with an
      // id after `run.taskId`; stops if nothing later is ready.
      const next = pickNextReadyTask(tasks, run.taskId);
      if (next) {
        // Second line of defense: re-read the picked task now that we hold the
        // lock. Statuses can have moved (another path started it) while we
        // waited on the lock — if it's no longer `ready`, don't double-submit.
        const fresh = await readTaskFile(project, next.id);
        if (!fresh || fresh.frontmatter.status !== "ready") return;

        // Queue is not empty after all — clear any stale queue-empty nudge.
        const { resolveQueueEmptyNudges } = await import("../inbox/queue-empty.ts");
        await resolveQueueEmptyNudges(db, events, project.id);
        // Dynamic import to break the cycle: submit.ts → runner.ts (via
        // executeRun), and runner.ts imports this module.
        const { submitRun } = await import("./submit.ts");
        await submitRun(
          { config, db, events, runs, pool },
          { projectId: project.id, taskId: next.id },
        );
      } else {
        // Auto-advance ran but found nothing ready to pick up — the project's
        // queue just drained. A hands-off project auto-plans its next milestone
        // and starts it with no operator tap; every other preset just nudges.
        const advanced = await maybeAutoPlanAndAdvance(deps, project);
        if (!advanced) {
          const { maybeEmitQueueEmptyNudge } = await import("../inbox/queue-empty.ts");
          await maybeEmitQueueEmptyNudge(db, events, project);
        }
      }
    });
  }
}

/**
 * Hands-off auto-plan + auto-execute (queue-drain branch). When a hands-off
 * project's ready queue drains, re-decompose its SPEC into the next milestone's
 * tasks and immediately cold-start the replenished queue — closing the loop so
 * an unattended project keeps building without an operator confirming a plan.
 *
 * Returns true when the queue was replenished (tasks created), meaning the
 * caller must NOT emit a queue-empty nudge. Returns false for every other
 * preset, or when planning produced nothing (no committed SPEC, agent error, or
 * an empty decomposition) — the caller then falls back to the manual nudge.
 *
 * Runs inside the caller's per-project `autoAdvanceLock`, so the agent call is
 * serialized against other finalizations on the same project — a hands-off
 * project can only be auto-planning one milestone at a time.
 */
async function maybeAutoPlanAndAdvance(deps: PostMergeDeps, project: Project): Promise<boolean> {
  const { config, db, events, runs, pool } = deps;
  if (matchingAutonomyPreset(db, project.id) !== "hands-off") return false;

  const { autoPlanNextMilestone } = await import("../projects/auto-milestone.ts");
  const planned = await autoPlanNextMilestone(
    { config, db, agentInvoker: deps.agentInvoker },
    project,
  );
  if (planned.created === 0) return false;

  // Leave a discoverable, timestamped record that a whole milestone was
  // auto-planned + auto-executed unattended under the hands-off preset. This
  // lands in the read-only autonomy history (/ops timeline, ADR-016) — an
  // awareness surface, never an action queue — so it needs no operator tap and
  // adds no must-respond inbox card (the "one attention sink" invariant).
  const { recordAutonomyEvent } = await import("../autonomy/events.ts");
  recordAutonomyEvent(db, events, {
    kind: "milestone_auto_planned",
    projectId: project.id,
    message: `hands-off: auto-planned + started milestone "${planned.milestone}" (${planned.created} task${
      planned.created === 1 ? "" : "s"
    })`,
    detail: {
      preset: "hands-off",
      milestone: planned.milestone,
      created: planned.created,
      taskIds: planned.taskIds,
      blastRadius: planned.blast?.radius ?? null,
    },
  });

  // Queue replenished. Cold-start from the front of the fresh queue (null anchor,
  // mirroring idle-advance) — the just-finished task id is no anchor for a batch
  // of brand-new tasks. The post-merge chain takes over from the next finalize.
  const tasks = await listTasks(project);
  const next = pickNextReadyTask(tasks, null);
  if (next) {
    const fresh = await readTaskFile(project, next.id);
    if (fresh && fresh.frontmatter.status === "ready") {
      const { resolveQueueEmptyNudges } = await import("../inbox/queue-empty.ts");
      await resolveQueueEmptyNudges(db, events, project.id);
      const { submitRun } = await import("./submit.ts");
      await submitRun(
        { config, db, events, runs, pool },
        { projectId: project.id, taskId: next.id },
      );
    }
  }
  // Tasks exist now — a queue-empty nudge would be wrong even if the pick raced.
  return true;
}
