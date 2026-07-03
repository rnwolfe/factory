import { type Db, schema } from "@factory/db";
import { mergeIntoMain, resetToClean } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { WorkerPool } from "./pool.ts";
import { applyPostMergeRunOutcome } from "./post-merge.ts";
import type { RunRegistry } from "./registry.ts";

/**
 * Merge remediation (feature plan mnx1zt27). When a run's auto-merge to `main`
 * fails because `main` was dirty (`reason: "dirty"`), the conservative baseline
 * strands the work on its branch behind a manual git-surgery session. This
 * module resets `main` to a clean state and re-attempts the merge — the single
 * primitive behind both the unattended path (runner, gated on
 * `mergeRemediation.dirtyAutoReset`) and the operator tap
 * (`decisions.resolveMergeFailureDirty`).
 *
 * It is deliberately scoped to the `dirty` failure mode: a hard reset can only
 * *safely* recover uncommitted cruft on `main` (a stray task file, leftover
 * build output). A `conflict` needs a real resolution, not a reset — that stays
 * on the tmux-intervention path.
 */

export interface MergeRemediationDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

export interface DirtyRemediationParams {
  projectId: string;
  runId: string;
  taskId?: string | null;
  branch: string;
}

export type DirtyRemediationResult =
  | { ok: true; sha: string; alreadyMerged: boolean }
  | { ok: false; reason: string; message: string };

/**
 * Reset a project's dirty `main` to a clean state, then re-attempt the run
 * branch merge. On success, fires the post-merge side effects the runner held
 * when the original merge failed (task-status reconcile + auto-advance) so the
 * remediation lands identically to an operator-approved retry. On failure,
 * returns the merge result unchanged so the caller can leave the decision
 * pending and fall back to the tmux-intervention path (acceptance §5).
 */
export async function resetMainAndRetryMerge(
  deps: MergeRemediationDeps,
  params: DirtyRemediationParams,
): Promise<DirtyRemediationResult> {
  const project = await deps.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, params.projectId))
    .get();
  if (!project) return { ok: false, reason: "other", message: "project not found" };

  // Discard the uncommitted changes that blocked the merge, then retry.
  await resetToClean(project.workdirPath);

  const taskLabel = params.taskId ?? "ad-hoc";
  const merge = await mergeIntoMain({
    projectPath: project.workdirPath,
    branch: params.branch,
    message: `chore: merge ${taskLabel} · run ${params.runId.slice(0, 8)} (reset+retry)`,
    author: deps.config.gitAuthor,
  });
  if (!merge.ok) return { ok: false, reason: merge.reason, message: merge.message };

  if (!merge.alreadyMerged) {
    deps.events.publish({
      channel: "events",
      kind: "commit",
      runId: params.runId,
      iteration: 1,
      sha: merge.sha,
      subject: `merge to main: ${params.branch}`,
      projectId: project.id,
    });
  }

  // Fire the post-merge side effects the runner held when the merge failed.
  // Best-effort: a reconcile hiccup must not undo a landed merge.
  try {
    await applyPostMergeRunOutcome(
      {
        config: deps.config,
        db: deps.db,
        events: deps.events,
        runs: deps.runs,
        pool: deps.pool,
      },
      params.runId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[merge-remediation] post-merge reconcile failed for run ${params.runId}: ${msg}`);
  }

  return { ok: true, sha: merge.sha, alreadyMerged: merge.alreadyMerged };
}
