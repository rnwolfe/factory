import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import {
  commitAllChanges,
  followFileBytes,
  mergeIntoMain,
  shellQuote,
  startTmuxSession,
  type TailHandle,
  type TmuxSessionHandle,
} from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { WorkerPool } from "../workers/pool.ts";
import { applyPostMergeRunOutcome } from "../workers/post-merge.ts";
import type { RunRegistry } from "../workers/registry.ts";
import { submitRun } from "../workers/submit.ts";

/**
 * Operator-driven repair on a blocked run or merge failure.
 *
 * An intervention spawns a tmux session over an EXISTING worktree (the
 * blocked run's, or the project's main checkout for a merge failure) —
 * no new worktree, no own branch. The operator inspects git state,
 * fixes whatever broke, then signals "resume". The terminal action is
 * decision-kind-dependent:
 *
 *   blocked_run    → auto-commit dirty work onto the source run's
 *                    branch, submit a NEW run with `--resume <sessionId>`
 *                    threading the intervention summary forward as
 *                    operatorContext. Same Claude session, same agent
 *                    reasoning chain — the agent picks up where it left
 *                    off and sees the new commits in git status.
 *
 *   merge_failure  → re-run `mergeIntoMain` on the run's branch. The
 *                    operator presumably resolved whatever made main
 *                    dirty / conflicted.
 *
 * Cancel leaves the decision pending and the worktree as-is. The
 * operator can intervene again, retry without intervention, or dismiss.
 *
 * Daemon-restart resilience matches sessions: in-memory handles don't
 * survive, but the DB row + worktree state do. `recoverOrphanedInterventions`
 * marks active rows as `orphaned` on boot.
 */

export class InterventionError extends Error {
  constructor(
    public readonly code:
      | "decision_not_found"
      | "decision_not_pending"
      | "decision_kind_unsupported"
      | "intervention_not_found"
      | "intervention_not_active"
      | "intervention_already_active"
      | "source_run_not_found"
      | "project_not_found"
      | "tmux_failed"
      | "no_tmux"
      | "no_session_id"
      | "merge_failed",
    message: string,
  ) {
    super(message);
    this.name = "InterventionError";
  }
}

interface ActiveHandle {
  interventionId: string;
  tmux: TmuxSessionHandle;
  tail: TailHandle;
  abort: AbortController;
}

class InterventionRegistry {
  private map = new Map<string, ActiveHandle>();
  set(id: string, h: ActiveHandle): void {
    this.map.set(id, h);
  }
  get(id: string): ActiveHandle | undefined {
    return this.map.get(id);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
}

const registry = new InterventionRegistry();

async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = bunSpawn({ cmd: ["tmux", "-V"], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

interface BlockedRunPayload {
  runId: string;
  taskId?: string | null;
  summary?: string;
  questions?: string[];
  branch?: string;
}

interface MergeFailurePayload {
  runId?: string;
  sessionId?: string;
  taskId?: string | null;
  branch: string;
  reason?: string;
  message?: string;
  summary?: string;
}

export interface InterventionOrchestrateDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

export interface StartedIntervention {
  interventionId: string;
  decisionKind: "blocked_run" | "merge_failure";
  worktreePath: string;
  tmuxSessionName: string;
}

/**
 * Start an intervention on a pending blocked_run or merge_failure decision.
 * Refuses if an intervention is already active on this decision (operator
 * cancels first if they want a fresh tmux). Decides which worktree to root
 * the tmux at based on the decision kind.
 */
export async function startIntervention(
  deps: InterventionOrchestrateDeps,
  decisionId: string,
): Promise<StartedIntervention> {
  const { db, events } = deps;

  if (!(await tmuxAvailable())) {
    throw new InterventionError("no_tmux", "tmux is not available on PATH");
  }

  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!decision) {
    throw new InterventionError("decision_not_found", `decision ${decisionId} not found`);
  }
  if (decision.status !== "pending") {
    throw new InterventionError(
      "decision_not_pending",
      `decision is ${decision.status} — interventions only valid on pending decisions`,
    );
  }
  if (decision.kind !== "blocked_run" && decision.kind !== "merge_failure") {
    throw new InterventionError(
      "decision_kind_unsupported",
      `intervene is only supported on blocked_run and merge_failure decisions (got ${decision.kind})`,
    );
  }

  // One active intervention per decision at a time.
  const existingActive = await db
    .select({ id: schema.interventions.id })
    .from(schema.interventions)
    .where(
      and(
        eq(schema.interventions.decisionId, decisionId),
        eq(schema.interventions.status, "active"),
      ),
    )
    .all();
  if (existingActive.length > 0) {
    throw new InterventionError(
      "intervention_already_active",
      `decision ${decisionId} already has an active intervention (${existingActive[0]?.id}); cancel it first`,
    );
  }

  // Resolve worktreePath + sourceRunId based on kind.
  let worktreePath: string;
  let sourceRunId: string | null = null;
  let projectId: string;
  if (decision.kind === "blocked_run") {
    const payload = decision.payload as BlockedRunPayload;
    if (!payload.runId) {
      throw new InterventionError("source_run_not_found", "blocked_run decision missing runId");
    }
    const sourceRun = await db
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        worktreePath: schema.runs.worktreePath,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, payload.runId))
      .get();
    if (!sourceRun) {
      throw new InterventionError("source_run_not_found", `source run ${payload.runId} not found`);
    }
    worktreePath = sourceRun.worktreePath;
    sourceRunId = sourceRun.id;
    projectId = sourceRun.projectId;
  } else {
    // merge_failure: tmux over the project's main workdir — that's where
    // the merge failed, and where the operator needs to reconcile state.
    if (!decision.projectId) {
      throw new InterventionError("project_not_found", "merge_failure decision missing projectId");
    }
    const project = await db
      .select({ id: schema.projects.id, workdirPath: schema.projects.workdirPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, decision.projectId))
      .get();
    if (!project) {
      throw new InterventionError("project_not_found", `project ${decision.projectId} not found`);
    }
    worktreePath = project.workdirPath;
    projectId = project.id;
    // Capture the source run id for context, even though we don't need
    // it for the resume action — handy for forensics.
    const payload = decision.payload as MergeFailurePayload;
    sourceRunId = payload.runId ?? null;
  }

  const interventionId = createId();
  const tmuxSessionName = `factoryd-intervene-${interventionId.slice(0, 12)}`;

  // Pane log file → followFileBytes → /ws/pane fanout, mirroring sessions.
  const logsDir = path.join(deps.config.worktreesRoot, "_intervention-logs");
  await mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${interventionId}.log`);
  await writeFile(logPath, "", "utf8");

  // Operator gets their actual shell. We don't pre-launch claude here —
  // this is the operator's repair session, not an agent run. The agent
  // continues on `resume`, in a separate run with `--resume <sessionId>`.
  const innerCommand = `sh -c ${shellQuote(`sleep 0.15; exec ${"$"}{SHELL:-/bin/sh}`)}`;

  let tmux: TmuxSessionHandle;
  try {
    tmux = await startTmuxSession({
      sessionName: tmuxSessionName,
      cwd: worktreePath,
      command: innerCommand,
      logSocketPath: logPath,
      env: { TERM: "xterm-256color" },
    });
  } catch (err) {
    throw new InterventionError("tmux_failed", (err as Error).message);
  }

  await db.insert(schema.interventions).values({
    id: interventionId,
    decisionId,
    decisionKind: decision.kind,
    projectId,
    sourceRunId,
    worktreePath,
    tmuxSessionName,
    status: "active",
    startedAt: Date.now(),
  });

  const abort = new AbortController();
  const tail = followFileBytes(
    logPath,
    (chunk) => {
      events.publish({
        channel: "pane",
        // Reuse the runId field as the pane carrier — interventions and
        // sessions and runs all share the same /ws/pane fanout.
        runId: interventionId,
        bytes: chunk,
      });
    },
    abort.signal,
  );
  registry.set(interventionId, { interventionId, tmux, tail, abort });

  events.publish({
    channel: "inbox",
    kind: "decision_updated",
    decisionId,
    projectId,
  });

  return {
    interventionId,
    decisionKind: decision.kind,
    worktreePath,
    tmuxSessionName,
  };
}

/**
 * Tear down an intervention's tmux + tail without doing the resume action.
 * Decision stays pending; operator can intervene again, retry, or dismiss.
 */
export async function cancelIntervention(
  deps: InterventionOrchestrateDeps,
  interventionId: string,
): Promise<void> {
  const { db, events } = deps;
  const row = await db
    .select()
    .from(schema.interventions)
    .where(eq(schema.interventions.id, interventionId))
    .get();
  if (!row) {
    throw new InterventionError(
      "intervention_not_found",
      `intervention ${interventionId} not found`,
    );
  }
  if (row.status !== "active") {
    throw new InterventionError(
      "intervention_not_active",
      `intervention is ${row.status}, not active`,
    );
  }

  await teardownHandle(interventionId);

  await db
    .update(schema.interventions)
    .set({ status: "cancelled", endedAt: Date.now() })
    .where(eq(schema.interventions.id, interventionId));

  events.publish({
    channel: "inbox",
    kind: "decision_updated",
    decisionId: row.decisionId,
    projectId: row.projectId,
  });
}

export interface ResumeResult {
  /** New run id when blocked_run; null when merge_failure. */
  newRunId: string | null;
  /** Merge sha when merge_failure succeeded; null otherwise. */
  mergedSha: string | null;
}

/**
 * End the intervention and trigger its decision-kind-specific action.
 */
export async function resumeFromIntervention(
  deps: InterventionOrchestrateDeps,
  interventionId: string,
): Promise<ResumeResult> {
  const { db } = deps;
  const row = await db
    .select()
    .from(schema.interventions)
    .where(eq(schema.interventions.id, interventionId))
    .get();
  if (!row) {
    throw new InterventionError(
      "intervention_not_found",
      `intervention ${interventionId} not found`,
    );
  }
  if (row.status !== "active") {
    throw new InterventionError(
      "intervention_not_active",
      `intervention is ${row.status}, not active`,
    );
  }

  // Tear down tmux first — the operator is done editing. Subsequent git
  // operations need exclusive access to the worktree.
  await teardownHandle(interventionId);

  if (row.decisionKind === "blocked_run") {
    return finalizeBlockedRunResume(deps, row);
  }
  return finalizeMergeFailureResume(deps, row);
}

async function finalizeBlockedRunResume(
  deps: InterventionOrchestrateDeps,
  intervention: typeof schema.interventions.$inferSelect,
): Promise<ResumeResult> {
  const { config, db, events } = deps;

  if (!intervention.sourceRunId) {
    throw new InterventionError(
      "source_run_not_found",
      "blocked_run intervention is missing sourceRunId",
    );
  }
  const source = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, intervention.sourceRunId))
    .get();
  if (!source) {
    throw new InterventionError(
      "source_run_not_found",
      `source run ${intervention.sourceRunId} not found`,
    );
  }
  if (!source.sessionId) {
    throw new InterventionError(
      "no_session_id",
      `source run has no claude session_id — cannot resume the conversation. Use plain "retry" instead.`,
    );
  }

  // Auto-commit any operator edits onto the source run's branch. Mirrors
  // runner.ts's post-spawn `commitAllChanges` so dirty work doesn't get
  // stranded in the worktree when the agent resumes from a fresh checkout.
  let interventionCommitInfo: string;
  try {
    const committed = await commitAllChanges(
      intervention.worktreePath,
      `chore: operator intervention on ${intervention.id.slice(0, 8)}`,
      config.gitAuthor,
    );
    interventionCommitInfo = committed
      ? `Operator made changes during intervention and they were committed as ${committed.sha.slice(0, 8)} on this branch. Run 'git log --oneline -5' to inspect.`
      : "Operator opened an intervention session but the worktree was clean (no changes committed).";
  } catch (err) {
    interventionCommitInfo = `Operator intervention attempted to auto-commit but failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Gather the operator's thread replies (same shape as the plain retry
  // path — see decisions.ts:renderBlockedRunOperatorContext).
  const thread = await db
    .select()
    .from(schema.decisionComments)
    .where(eq(schema.decisionComments.decisionId, intervention.decisionId))
    .orderBy(asc(schema.decisionComments.createdAt))
    .all();
  const operatorReplies = thread.filter((c) => c.role === "operator");

  const decisionRow = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, intervention.decisionId))
    .get();
  const decisionPayload = (decisionRow?.payload ?? {}) as BlockedRunPayload;
  const header = `## Operator notes (from prior blocked run + intervention)

The operator opened an intervention session over your worktree, then chose
to resume. Treat the notes below as authoritative — they're the operator's
most recent intent and the resolution path for whatever blocked you.`;
  const questionsBlock =
    decisionPayload.questions && decisionPayload.questions.length > 0
      ? `### Questions you asked\n\n${decisionPayload.questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}\n\n`
      : "";
  const repliesBlock =
    operatorReplies.length > 0
      ? `${operatorReplies
          .map(
            (c) =>
              `### Operator reply · ${new Date(c.createdAt).toISOString()}\n\n${c.body.trim()}`,
          )
          .join("\n\n")}\n\n`
      : "";
  const operatorContext = `${header}\n\n${questionsBlock}${repliesBlock}### Operator intervention\n\n${interventionCommitInfo}\n\nWhen you continue, run \`git status\` and \`git log --oneline -10\` first to see the current worktree state.`;

  // Submit a new run that REUSES the source's worktree + branch. Critical:
  // a fresh sibling worktree branched from source.branch would lose the
  // gitignored data (corpus, .env*, build artifacts, node_modules,
  // anything in .gitignore) that the agent and operator just spent time
  // building up. The only state that carries forward via git is committed
  // files. By reusing the worktree, the resumed agent boots into the
  // exact filesystem state the operator left behind — the operator's
  // intervention isn't wasted.
  //
  // sessionId is inherited from source via reuseFromRunId; runner.ts in
  // resume mode passes it to runtime.spawn for `claude --resume`.
  const result = await submitRun(
    {
      config,
      db,
      events: deps.events,
      runs: deps.runs,
      pool: deps.pool,
    },
    {
      projectId: intervention.projectId,
      taskId: source.taskId ?? undefined,
      operatorContext,
      reuseFromRunId: source.id,
    },
  );

  // Mark the intervention resumed and the decision actioned.
  const now = Date.now();
  await db
    .update(schema.interventions)
    .set({ status: "resumed", endedAt: now })
    .where(eq(schema.interventions.id, intervention.id));
  await db
    .update(schema.decisions)
    .set({ status: "actioned", actionedAt: now })
    .where(eq(schema.decisions.id, intervention.decisionId));

  events.publish({
    channel: "inbox",
    kind: "decision_actioned",
    decisionId: intervention.decisionId,
    projectId: intervention.projectId,
  });

  return { newRunId: result.runId, mergedSha: null };
}

async function finalizeMergeFailureResume(
  deps: InterventionOrchestrateDeps,
  intervention: typeof schema.interventions.$inferSelect,
): Promise<ResumeResult> {
  const { config, db, events } = deps;

  const decisionRow = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, intervention.decisionId))
    .get();
  if (!decisionRow) {
    throw new InterventionError(
      "decision_not_found",
      `decision ${intervention.decisionId} not found`,
    );
  }
  const payload = decisionRow.payload as MergeFailurePayload;

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, intervention.projectId))
    .get();
  if (!project) {
    throw new InterventionError("project_not_found", `project ${intervention.projectId} not found`);
  }

  const taskLabel = payload.taskId ?? "ad-hoc";
  const runShort = payload.runId ? payload.runId.slice(0, 8) : intervention.id.slice(0, 8);
  const merge = await mergeIntoMain({
    projectPath: project.workdirPath,
    branch: payload.branch,
    message: `chore: merge ${taskLabel} · run ${runShort} (after intervention)`,
    author: config.gitAuthor,
  });

  if (!merge.ok) {
    // Leave the decision pending. Mark intervention 'cancelled' rather
    // than 'resumed' so the operator can intervene again with a fresh
    // tmux. The merge error is the same operator-actionable text the
    // plain retry path surfaces.
    const now = Date.now();
    await db
      .update(schema.interventions)
      .set({ status: "cancelled", endedAt: now })
      .where(eq(schema.interventions.id, intervention.id));
    events.publish({
      channel: "inbox",
      kind: "decision_updated",
      decisionId: intervention.decisionId,
      projectId: intervention.projectId,
    });
    throw new InterventionError(
      "merge_failed",
      `merge still failing — ${merge.reason}: ${merge.message}`,
    );
  }

  if (!merge.alreadyMerged) {
    events.publish({
      channel: "events",
      kind: "commit",
      runId: payload.runId ?? intervention.id,
      iteration: 1,
      sha: merge.sha,
      subject: `merge to main: ${payload.branch}`,
      projectId: intervention.projectId,
    });
  }

  // Fire the post-merge reconcile that the runner held while the merge was
  // failing. Scoped to run-backed merge_failure interventions; the ad-hoc-
  // session variant carries a `sessionId` instead and has no task to
  // reconcile.
  if (payload.runId) {
    try {
      await applyPostMergeRunOutcome(deps, payload.runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[intervention] post-merge reconcile failed for run ${payload.runId}: ${msg}`);
    }
  }

  const now = Date.now();
  await db
    .update(schema.interventions)
    .set({ status: "resumed", endedAt: now })
    .where(eq(schema.interventions.id, intervention.id));
  await db
    .update(schema.decisions)
    .set({ status: "actioned", actionedAt: now })
    .where(eq(schema.decisions.id, intervention.decisionId));
  events.publish({
    channel: "inbox",
    kind: "decision_actioned",
    decisionId: intervention.decisionId,
    projectId: intervention.projectId,
  });

  return { newRunId: null, mergedSha: merge.sha };
}

async function teardownHandle(interventionId: string): Promise<void> {
  const handle = registry.get(interventionId);
  if (!handle) return;
  handle.abort.abort();
  try {
    if (await handle.tmux.exists()) await handle.tmux.kill();
  } catch {
    // ignore — tmux session may have died on its own
  }
  await handle.tail.stop().catch(() => {});
  registry.delete(interventionId);
}

/**
 * Boot-time recovery. Any intervention rows still tagged `active` belong
 * to a daemon process that's gone. The tmux session it owned is dead
 * (no parent to read its pane), so mark the row `orphaned` and emit a
 * decision_updated so the PWA refreshes.
 *
 * The decision the intervention was attached to is left untouched — the
 * operator can intervene again, plain-retry, or dismiss. Worktree files
 * (and any commits the operator made before the daemon died) stay on
 * disk; only the in-memory tmux + tail handles are lost.
 */
export async function recoverOrphanedInterventions(db: Db, events: EventBus): Promise<number> {
  const orphans = await db
    .select({
      id: schema.interventions.id,
      decisionId: schema.interventions.decisionId,
      projectId: schema.interventions.projectId,
      tmuxSessionName: schema.interventions.tmuxSessionName,
    })
    .from(schema.interventions)
    .where(eq(schema.interventions.status, "active"))
    .all();
  if (orphans.length === 0) return 0;

  // Best-effort: kill any leftover tmux sessions that survived the prior
  // daemon (tmux is a separate server process and outlives our daemon).
  for (const o of orphans) {
    try {
      const proc = bunSpawn({
        cmd: ["tmux", "kill-session", "-t", o.tmuxSessionName],
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch {
      // ignore
    }
  }

  await db
    .update(schema.interventions)
    .set({ status: "orphaned", endedAt: Date.now() })
    .where(
      inArray(
        schema.interventions.id,
        orphans.map((o) => o.id),
      ),
    );

  for (const o of orphans) {
    events.publish({
      channel: "inbox",
      kind: "decision_updated",
      decisionId: o.decisionId,
      projectId: o.projectId,
    });
  }
  return orphans.length;
}

/** True when the intervention has a live in-memory handle (tmux + tail). */
export function isInterventionActive(interventionId: string): boolean {
  return registry.get(interventionId) !== undefined;
}

export function tmuxNameForIntervention(interventionId: string): string | null {
  return registry.get(interventionId)?.tmux.sessionName ?? null;
}
