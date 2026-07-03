import path from "node:path";
import { type Db, schema } from "@factory/db";
import {
  finalizeConflictResolution,
  mergeIntoMain,
  prepareConflictResolution,
  removeWorktree,
} from "@factory/runtime";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import { recordAutonomyEvent } from "../autonomy/events.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { recordMergeFailure } from "./merge-failure.ts";
import type { WorkerPool } from "./pool.ts";
import { applyPostMergeRunOutcome } from "./post-merge.ts";
import type { RunRegistry } from "./registry.ts";

/**
 * Conflict auto-resolve (feature plan mnx1zt27) — the conflict sibling of
 * `merge-remediation.ts`'s dirty-reset lever. When a run's auto-merge to `main`
 * fails with `reason: "conflict"`, the conservative baseline strands the work on
 * its branch behind a manual git-surgery session. This module instead stages the
 * conflict in an ISOLATED scratch worktree and hands it to a non-interactive
 * `claude --print` agent (project agent/model) to resolve — the same
 * fenced-JSON structured-completion + null-parse-fail discipline as triage and
 * audits.
 *
 * Two entry points mirror the dirty path:
 *   • `remediateMergeConflict` — the runner-side policy: read the
 *     `mergeRemediation.conflictAutoResolve` lever, produce a resolution, then
 *     either land it unattended (`true`) or attach it to a pending decision as a
 *     *proposed* resolution the operator taps to apply (`false`).
 *   • `landConflictResolution` — the shared landing primitive (used unattended
 *     and on operator approval): merge the resolution branch into `main` via the
 *     existing `mergeIntoMain` path + fire the held post-merge side effects.
 *
 * The agent NEVER touches the project's main checkout: it resolves on a throwaway
 * `factory/resolve-<runId>` branch in a scratch worktree. That branch ref is kept
 * (the worktree is torn down) so an operator can apply the proposal later. A
 * blocked / failed / null-parsed resolution — or a validation failure — always
 * falls through to the plain pending decision, so the tmux-intervention fallback
 * is untouched and a `true` lever never forces a merge through a bad resolution.
 */

export interface ConflictRemediationDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

export interface ConflictRemediationParams {
  projectId: string;
  runId: string;
  taskId?: string | null;
  branch: string;
  /** The original merge failure message (for the surfaced decision payload). */
  mergeMessage: string;
  /** The run summary, echoed onto the decision payload for the inbox card. */
  summary?: string;
}

export interface ResolveConflictOptions {
  /**
   * Test seam mirroring triage's `agentInvoker`. Receives the rendered prompt
   * and the scratch worktree path (its cwd); must perform the resolution in that
   * worktree and return the agent's fenced-JSON status text. When omitted, the
   * real `claude --print` agent runs against the worktree.
   */
  agentInvoker?: (prompt: string, cwd: string) => Promise<string>;
  /** Wall-clock cap for the agent. Default: config's agentBudgetSeconds. */
  budgetSeconds?: number;
}

/** The structured completion the resolution agent emits (fenced JSON). */
interface ResolutionStatus {
  status: "done" | "blocked" | "failed";
  summary?: string;
  files_resolved?: string[];
}

/** The produced-but-not-yet-landed resolution, stashed on the decision payload. */
export interface ProposedResolution {
  /** Branch ref holding the resolved merge commit (worktree already removed). */
  resolveBranch: string;
  /** The resolved merge commit SHA. */
  resolutionSha: string;
  /** The agent's summary of what it did. */
  agentSummary: string;
  /** `git show --stat` of the resolution, for after-the-fact review. */
  diffStat: string;
}

export type ProduceResolutionResult =
  | { ok: true; resolution: ProposedResolution; metricsRecorded: boolean }
  | { ok: false; reason: string; message: string };

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

function buildResolutionPrompt(params: {
  projectName: string;
  runBranch: string;
  targetBranch: string;
  conflictedFiles: string[];
}): string {
  const fileList =
    params.conflictedFiles.length > 0
      ? params.conflictedFiles.map((f) => `  - ${f}`).join("\n")
      : "  (see `git status` for the conflicted paths)";
  return [
    `You are resolving a git merge conflict in the "${params.projectName}" project.`,
    "",
    `Your current working directory is a throwaway git worktree. A merge of the run`,
    `branch \`${params.runBranch}\` into \`${params.targetBranch}\` is IN PROGRESS and has`,
    `conflicts. The conflicted files:`,
    fileList,
    "",
    "Your job:",
    `  1. Inspect the conflicts (\`git status\`, \`git diff\`, read the files).`,
    "  2. Resolve EVERY conflict, preserving the intent of BOTH sides — never blindly",
    "     discard one side. When both sides changed the same logic, integrate them.",
    "  3. Remove all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).",
    "  4. `git add` the resolved files and complete the merge with",
    "     `git commit --no-edit` (or `git commit -m` with a clear message).",
    "  5. Do NOT touch files that were not part of the conflict, and do NOT run tests,",
    "     installs, or any command that mutates state outside this worktree.",
    "",
    "This is a non-interactive run. When finished, end your response with a single",
    "fenced block:",
    "",
    "```factory-status",
    '{"status": "done" | "blocked" | "failed",',
    ' "summary": "One or two sentences on how you resolved the conflict.",',
    ' "files_resolved": ["path/one", "path/two"]}',
    "```",
    "",
    "Use status `done` ONLY if every conflict is resolved and the merge is committed.",
    "If the conflict is genuinely unresolvable without operator input, use `blocked`",
    "with a summary of what's ambiguous. Never leave conflict markers behind.",
  ].join("\n");
}

/**
 * Walk `text` and return the first balanced `{...}` object as a string, tracking
 * string boundaries so braces inside JSON values don't skew the depth count.
 * Mirrors triage's extractor — kept local to avoid cross-module coupling.
 */
function findBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseResolutionStatus(text: string): ResolutionStatus | null {
  const candidates: string[] = [text];
  const fence = /```(?:json|factory-status)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1] ?? "");
  }
  for (const candidate of candidates) {
    const slice = findBalancedJsonObject(candidate);
    if (!slice) continue;
    try {
      const parsed = JSON.parse(slice) as ResolutionStatus;
      if (parsed && typeof parsed.status === "string") return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Produce a conflict resolution in an isolated scratch worktree. Does NOT land
 * it — returns the resolution branch + sha for the caller to merge (unattended)
 * or stash on a decision (operator approval). Removes the scratch worktree on
 * every exit; on failure the resolve branch is deleted too.
 */
export async function resolveMergeConflict(
  deps: ConflictRemediationDeps,
  params: ConflictRemediationParams,
  opts: ResolveConflictOptions = {},
): Promise<ProduceResolutionResult> {
  const project = await deps.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, params.projectId))
    .get();
  if (!project) return { ok: false, reason: "other", message: "project not found" };

  const resolveBranch = `factory/resolve-${params.runId}`;
  const worktreePath = path.join(
    deps.config.worktreesRoot,
    project.slug,
    `resolve-${params.runId}`,
  );
  const mergeSubject = `chore: resolve merge of ${params.branch} into main (run ${params.runId.slice(0, 8)})`;

  const cleanupWorktree = async () => {
    try {
      await removeWorktree({ projectPath: project.workdirPath, worktreePath, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[resolve-conflict] worktree teardown failed for ${params.runId}: ${msg}`);
    }
  };
  const deleteResolveBranch = async () => {
    // Best-effort: the branch is garbage once we've abandoned the resolution.
    await runGit(["branch", "-D", resolveBranch], project.workdirPath);
  };

  const prepared = await prepareConflictResolution({
    projectPath: project.workdirPath,
    branch: params.branch,
    resolveBranch,
    worktreePath,
    author: deps.config.gitAuthor,
    message: mergeSubject,
  });

  if (prepared.status === "error") {
    await cleanupWorktree();
    await deleteResolveBranch();
    return { ok: false, reason: "prepare-failed", message: prepared.message };
  }

  // The merge applied with no conflict (state shifted since the original merge).
  // Nothing for the agent to do — the resolution is already the clean merge.
  if (prepared.status === "clean") {
    const diffStat = (
      await runGit(["show", "--stat", "--oneline", prepared.sha], worktreePath)
    ).stdout.trim();
    await cleanupWorktree();
    return {
      ok: true,
      metricsRecorded: false,
      resolution: {
        resolveBranch,
        resolutionSha: prepared.sha,
        agentSummary: "Merge applied cleanly on retry — no conflict to resolve.",
        diffStat,
      },
    };
  }

  // Hand the staged conflict to the agent (cwd = scratch worktree).
  const prompt = buildResolutionPrompt({
    projectName: project.name,
    runBranch: params.branch,
    targetBranch: "main",
    conflictedFiles: prepared.conflictedFiles,
  });
  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  const agent = resolveAgent(deps.db, { projectAgent: project.agent });

  let responseText: string;
  let metricsRecorded = false;
  try {
    if (opts.agentInvoker) {
      responseText = await opts.agentInvoker(prompt, worktreePath);
    } else {
      const inv = await invokeClaudeJson(prompt, {
        budgetSeconds: budget,
        agent,
        model: project.model,
        cwd: worktreePath,
      });
      responseText = inv.text;
      if (inv.metrics) {
        await recordAgentMetrics({
          db: deps.db,
          ownerKind: "merge_conflict_resolve",
          ownerId: params.runId,
          projectId: project.id,
          agent,
          metrics: inv.metrics,
          now: Date.now(),
        });
        metricsRecorded = true;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await cleanupWorktree();
    await deleteResolveBranch();
    return { ok: false, reason: "agent-error", message: msg.slice(0, 400) };
  }

  const status = parseResolutionStatus(responseText);
  if (!status) {
    // Null parse → fail (same discipline as factory-status / triage).
    await cleanupWorktree();
    await deleteResolveBranch();
    return {
      ok: false,
      reason: "null-parse",
      message: "resolution agent emitted no parseable status block",
    };
  }
  if (status.status !== "done") {
    await cleanupWorktree();
    await deleteResolveBranch();
    return {
      ok: false,
      reason: `agent-${status.status}`,
      message: status.summary ?? `resolution agent reported ${status.status}`,
    };
  }

  // Validate + complete the merge — the guard that a lying "done" (markers left,
  // merge sidestepped) never lands. Runs regardless of lever state.
  const finalized = await finalizeConflictResolution({
    worktreePath,
    author: deps.config.gitAuthor,
    message: mergeSubject,
  });
  if (!finalized.ok) {
    await cleanupWorktree();
    await deleteResolveBranch();
    return { ok: false, reason: finalized.reason, message: finalized.message };
  }

  const diffStat = (
    await runGit(["show", "--stat", "--oneline", finalized.sha], worktreePath)
  ).stdout.trim();

  // Keep the resolve branch ref (durable resolution); reclaim the worktree disk.
  await cleanupWorktree();

  return {
    ok: true,
    metricsRecorded,
    resolution: {
      resolveBranch,
      resolutionSha: finalized.sha,
      agentSummary: status.summary ?? "Resolved merge conflict.",
      diffStat,
    },
  };
}

export type LandResolutionResult =
  | { ok: true; sha: string; alreadyMerged: boolean }
  | { ok: false; reason: string; message: string };

/**
 * Land a produced conflict resolution: merge its resolve branch into `main` via
 * the existing `mergeIntoMain` path, publish the commit, then fire the post-merge
 * side effects the runner held when the original merge failed (task reconcile +
 * auto-advance). Used both unattended (`conflictAutoResolve` true) and on
 * operator approval of a proposed resolution.
 */
export async function landConflictResolution(
  deps: ConflictRemediationDeps,
  params: { projectId: string; runId: string; taskId?: string | null; resolveBranch: string },
): Promise<LandResolutionResult> {
  const project = await deps.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, params.projectId))
    .get();
  if (!project) return { ok: false, reason: "other", message: "project not found" };

  const taskLabel = params.taskId ?? "ad-hoc";
  const merge = await mergeIntoMain({
    projectPath: project.workdirPath,
    branch: params.resolveBranch,
    message: `chore: merge ${taskLabel} · run ${params.runId.slice(0, 8)} (conflict-resolved)`,
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
      subject: `merge to main: ${params.resolveBranch}`,
      projectId: project.id,
    });
  }

  // The resolve branch is now reachable from main via the merge commit — delete
  // the intermediate ref so it doesn't accumulate. Best-effort.
  await runGit(["branch", "-D", params.resolveBranch], project.workdirPath);

  // Fire the post-merge side effects the runner held. Best-effort — a reconcile
  // hiccup must not undo a landed merge.
  try {
    await applyPostMergeRunOutcome(
      { config: deps.config, db: deps.db, events: deps.events, runs: deps.runs, pool: deps.pool },
      params.runId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[resolve-conflict] post-merge reconcile failed for run ${params.runId}: ${msg}`);
  }

  return { ok: true, sha: merge.sha, alreadyMerged: merge.alreadyMerged };
}

export type ConflictRemediationOutcome =
  /** Lever true, resolution produced + landed unattended. */
  | { handled: true; landed: true; sha: string; decisionId: string }
  /** Lever false, resolution produced + attached to a pending decision. */
  | { handled: true; landed: false; decisionId: string }
  /** Not remediated — runner falls through to the plain pending decision. */
  | { handled: false; reason: string; message: string };

/**
 * Runner-side policy for a `reason: "conflict"` merge failure. Reads the
 * `mergeRemediation.conflictAutoResolve` lever, produces a resolution, then:
 *   • lever true  → lands it via `landConflictResolution` + records an
 *     already-resolved merge_failure decision (audit trail, no inbox tap);
 *   • lever false → records a *pending* merge_failure decision carrying the
 *     proposed resolution for the operator to apply with one tap.
 * Any produce/validation/land failure returns `handled: false` so the caller
 * records the plain pending decision and the tmux fallback stays intact.
 */
export async function remediateMergeConflict(
  deps: ConflictRemediationDeps,
  params: ConflictRemediationParams,
  opts: ResolveConflictOptions = {},
): Promise<ConflictRemediationOutcome> {
  const project = await deps.db
    .select({ name: schema.projects.name, workdirPath: schema.projects.workdirPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, params.projectId))
    .get();
  if (!project) return { handled: false, reason: "other", message: "project not found" };

  const conflictAutoResolve = resolveAutonomyConfig(deps.db, params.projectId).mergeRemediation
    .conflictAutoResolve;

  const produced = await resolveMergeConflict(deps, params, opts).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false as const, reason: "other", message: msg };
  });
  if (!produced.ok) {
    return { handled: false, reason: produced.reason, message: produced.message };
  }
  const { resolution } = produced;

  const basePayload = {
    runId: params.runId,
    taskId: params.taskId ?? null,
    branch: params.branch,
    reason: "conflict",
    message: params.mergeMessage,
    summary: params.summary,
  };

  if (conflictAutoResolve) {
    const land = await landConflictResolution(deps, {
      projectId: params.projectId,
      runId: params.runId,
      taskId: params.taskId ?? null,
      resolveBranch: resolution.resolveBranch,
    });
    if (!land.ok) {
      // Produced a resolution but couldn't land it (e.g. main moved). Abandon it
      // and fall through to the plain pending decision + tmux fallback.
      await runGit(["branch", "-D", resolution.resolveBranch], project.workdirPath);
      return { handled: false, reason: land.reason, message: land.message };
    }

    recordAutonomyEvent(deps.db, deps.events, {
      kind: "auto_merged",
      projectId: params.projectId,
      runId: params.runId,
      message: `${project.name} auto-resolved a merge conflict and merged ${params.branch} unattended`,
      detail: { resolutionSha: resolution.resolutionSha },
    });

    const decisionId = await recordMergeFailure(deps.db, deps.events, {
      projectId: params.projectId,
      reason: "conflict",
      message: params.mergeMessage,
      resolvedOutcome: "merge:conflict-auto-resolved",
      payload: {
        ...basePayload,
        remediation: "conflict-auto-resolved",
        mergedSha: land.sha,
        proposedResolution: resolution,
      },
    });
    return { handled: true, landed: true, sha: land.sha, decisionId };
  }

  // Lever off: surface the resolution as a proposal requiring an operator tap.
  const decisionId = await recordMergeFailure(deps.db, deps.events, {
    projectId: params.projectId,
    reason: "conflict",
    message: params.mergeMessage,
    payload: {
      ...basePayload,
      proposedResolution: resolution,
    },
  });
  return { handled: true, landed: false, decisionId };
}
