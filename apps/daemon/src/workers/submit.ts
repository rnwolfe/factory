import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, desc, eq } from "drizzle-orm";
import {
  AGENT_NAMES,
  type AgentName,
  agentForModel,
  clampModelToAgent,
  getAgentDescriptor,
} from "../agents/registry.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { readTaskFile } from "../projects/tasks.ts";
import { readAllSettings, readOpsSettings } from "../settings/store.ts";
import type { WorkerPool } from "./pool.ts";
import type { RunRegistry } from "./registry.ts";
import { executeRun } from "./runner.ts";

/**
 * Resolve a ref name (branch, tag, "HEAD", or sha) to its sha in `cwd`.
 * Returns null when the ref doesn't exist — callers decide whether to
 * surface the failure or fall through to a default. Used at run creation
 * to freeze the run's base sha; without this, `runs.baseRef` would
 * either be null (fresh runs) or a branch name that drifts after submit.
 */
async function resolveSha(ref: string, cwd: string): Promise<string | null> {
  const proc = bunSpawn({
    cmd: ["git", "rev-parse", "--verify", ref],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return exitCode === 0 ? stdout.trim() : null;
}

export interface SubmitRunDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

export interface SubmitRunInput {
  projectId: string;
  taskId?: string;
  budgetSeconds?: number;
  /**
   * When set, the new worktree is created from this ref instead of project
   * HEAD. Used by the retry path: pass the source run's branch so the new
   * agent invocation picks up its predecessor's auto-commit + partial work.
   */
  baseRef?: string;
  /**
   * Operator-supplied answers / extra context, prepended to the agent's
   * prompt as a top-level "Operator notes" section. Used by the
   * blocked-run retry path: gathered comments from the decision thread
   * ride forward so the new run starts with answers to the prior run's
   * questions.
   */
  operatorContext?: string;
  /**
   * Resume an existing Claude conversation. When set, the new run row
   * is created with this `sessionId` already attached and the runner
   * is invoked with `opts.resume = true` — runtime.spawn passes
   * `claude --resume <sessionId>` so the agent picks up its prior
   * reasoning chain instead of starting fresh.
   *
   * Used by the post-intervention "resume agent" path: the operator
   * fixed something in the worktree, and we want the SAME Claude
   * session to continue from where it blocked, not a fresh run that
   * has to re-discover context.
   */
  resumeFromSessionId?: string;
  /**
   * Reuse the worktree path + branch of an existing run, instead of
   * creating a fresh worktree from `baseRef`. The new run still gets
   * its own row + runId, but operates on the same on-disk checkout
   * the source run was working in.
   *
   * Critical for the intervene-resume path: the source run's worktree
   * carries gitignored data (built artifacts, `.env*`, corpus/, etc.)
   * that the agent built up across the prior turn. A fresh sibling
   * worktree branched from the source's tip would have the committed
   * code but lose all that local-only state, and the resumed agent
   * would boot into an empty workspace and fail.
   *
   * When set, `baseRef` is ignored (the worktree is already on the
   * right branch). The new run row inherits the source's worktreePath
   * and branch verbatim.
   */
  reuseFromRunId?: string;
  /**
   * When this run is a retry of a prior run, the original run's id.
   * Stored on the new run row so retry chains are traceable.
   */
  retryOfRunId?: string;
  /**
   * Per-run agent override. Currently `claude-code` (default) or `codex`.
   * When set, beats the task-frontmatter / project default. Stored on the
   * run row so retry/resume paths bind to the same provider.
   */
  agent?: string;
  /**
   * Marks this run as executing a confirmed release proposal, carrying the
   * annotated tag (e.g. `v0.23.0`) the run is expected to create. After the
   * run's branch merges into `main`, the runner pushes `main` + this tag to
   * origin (from the project checkout, not the worktree). See ADR-008.
   */
  releaseTag?: string;
}

const SUPPORTED_AGENTS = new Set<string>(AGENT_NAMES);

function normalizeAgent(raw: string | undefined | null): AgentName | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  return SUPPORTED_AGENTS.has(v) ? (v as AgentName) : null;
}

/**
 * Insert a new run row and submit its execution to the worker pool.
 * Used by the runs router (operator-initiated) and by auto-advance
 * (runner-initiated) so both paths produce identical run rows.
 */
export async function submitRun(
  deps: SubmitRunDeps,
  input: SubmitRunInput,
): Promise<{ runId: string }> {
  const { config, db, events, runs, pool } = deps;

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();
  if (!project) throw new Error(`project not found: ${input.projectId}`);

  // Resolve a frozen task_plan if one exists for this task. Picks the most
  // recently frozen plan — operators can supersede a stale plan by freezing
  // a new one, and the latest wins.
  let taskPlanId: string | null = null;
  if (input.taskId) {
    const planRow = await db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(
        and(
          eq(schema.plans.projectId, project.id),
          eq(schema.plans.taskId, input.taskId),
          eq(schema.plans.kind, "task_plan"),
          eq(schema.plans.status, "frozen"),
        ),
      )
      .orderBy(desc(schema.plans.frozenAt))
      .get();
    taskPlanId = planRow?.id ?? null;
  }

  const runId = createId();
  const now = Date.now();

  // Default: fresh worktree at <worktreesRoot>/<slug>/<runId> on a new
  // branch. When reuseFromRunId is set, override both with the source
  // run's values so the new run operates on the existing on-disk
  // checkout (preserving gitignored data the agent built up).
  let branch = `factory/run-${runId}`;
  let worktreePath = `${config.worktreesRoot}/${project.slug}/${runId}`;
  let inheritedSessionId: string | null = null;
  if (input.reuseFromRunId) {
    const source = await db
      .select({
        branch: schema.runs.branch,
        worktreePath: schema.runs.worktreePath,
        sessionId: schema.runs.sessionId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, input.reuseFromRunId))
      .get();
    if (!source) {
      throw new Error(`reuseFromRunId target ${input.reuseFromRunId} not found`);
    }
    branch = source.branch;
    worktreePath = source.worktreePath;
    inheritedSessionId = source.sessionId;
  }

  const operatorContext = input.operatorContext?.trim();
  const resumeSessionId = input.resumeFromSessionId?.trim();
  // Explicit `resumeFromSessionId` wins over inherited (the orchestrate
  // layer may want to resume from the source's session even when not
  // reusing its worktree, or vice versa). Inherit only if the caller
  // didn't pass one.
  const sessionIdForRow =
    resumeSessionId && resumeSessionId.length > 0 ? resumeSessionId : inheritedSessionId;

  // Freeze the run's base sha at submit time. The runs.diff endpoint
  // relies on this to scope its diff to "what this run added"; without
  // it, the diff has to infer the base via `git merge-base main <branch>`,
  // which silently returns the branch tip after a `--no-ff` merge into
  // main (the merge makes the branch reachable from main, so the merge-
  // base shifts forward) and the operator sees an empty diff on the
  // run-detail page for any successfully-merged run.
  //
  // We resolve `input.baseRef ?? "main"` against the project workdir at
  // submit time (not at runtime), so the sha is deterministic and stays
  // valid even after main moves forward. Reuse-from-run paths skip this
  // (the worktree already exists and the source run's baseRef carries
  // forward via the diff endpoint's fallback chain).
  let baseRefSha: string | null = null;
  if (!input.reuseFromRunId) {
    baseRefSha = await resolveSha(input.baseRef ?? "main", project.workdirPath);
  }

  // Resolve effective model id, top-down:
  //   task.frontmatter.model  →  project.model  →  settings.default-model  →  null
  // Stored on the run row so resume/retry paths and metrics views see what
  // the run was actually invoked with, independent of any later changes to
  // the upstream values. Null means "let the provider's CLI pick its own default."
  let effectiveModel: string | null = null;
  // Resolve effective agent, top-down:
  //   submit input  →  task.frontmatter.agent  →  project.agent
  //     →  settings.default-agent  →  "claude-code"
  // The provider interpreting `effectiveModel` is determined by this name —
  // a codex model id passed to claude-code (or vice versa) would just bounce.
  let effectiveAgent = normalizeAgent(input.agent) ?? "claude-code";
  let agentResolvedFromInputOrTask = normalizeAgent(input.agent) !== null;
  if (input.taskId) {
    const taskFile = await readTaskFile(project, input.taskId);
    const raw = taskFile?.frontmatter.model;
    if (typeof raw === "string" && raw.trim().length > 0) effectiveModel = raw.trim();
    if (!normalizeAgent(input.agent)) {
      const fromFile = normalizeAgent(taskFile?.frontmatter.agent);
      if (fromFile) {
        effectiveAgent = fromFile;
        agentResolvedFromInputOrTask = true;
      }
    }
  }
  if (!effectiveModel && project.model) effectiveModel = project.model;
  if (!agentResolvedFromInputOrTask) {
    const fromProject = normalizeAgent(project.agent);
    if (fromProject) {
      effectiveAgent = fromProject;
      agentResolvedFromInputOrTask = true;
    }
  }
  if (!effectiveModel || !agentResolvedFromInputOrTask) {
    const ops = readOpsSettings(readAllSettings(db));
    if (!effectiveModel && ops.defaultModel) effectiveModel = ops.defaultModel;
    if (!agentResolvedFromInputOrTask && ops.defaultAgent) {
      const fromSettings = normalizeAgent(ops.defaultAgent);
      if (fromSettings) effectiveAgent = fromSettings;
    }
  }

  // Cross-agent model backstop. Agent and model resolve on independent ladders
  // above, so a model id pinned for one agent (e.g. `claude-opus-4-8` in a
  // task's frontmatter) can land on a run that resolved to a different agent
  // (e.g. codex, from the project default). The provider then gets a model it
  // can't run and dies within seconds with no factory-status footer — surfacing
  // as a "blocked run" with no actionable reason. When the model is definitively
  // owned by a *different* registered agent, drop it so the resolved agent uses
  // its own default. Models no descriptor claims (experimental/gated like
  // Fable 5, or future ids) are left opaque — only a known collision clamps.
  const clampedModel = clampModelToAgent(effectiveAgent, effectiveModel);
  if (clampedModel !== effectiveModel) {
    console.warn(
      `[submit] model "${effectiveModel}" belongs to agent "${agentForModel(effectiveModel ?? "")}" ` +
        `but this run resolved to "${effectiveAgent}" — dropping the model so ${effectiveAgent} ` +
        `uses its default (task ${input.taskId ?? "—"}, project ${project.id}).`,
    );
    effectiveModel = clampedModel;
  }

  // Parity-block precheck: when the operator selected an agent that does not
  // support session resume (codex) and the run path needs resume (operator's
  // explicit resumeFromSessionId, OR reuseFromRunId of a source that captured
  // a sessionId), refuse with an actionable error pointing at the parity
  // inventory. The PWA surfaces this verbatim. See docs/internal/codex-parity.md
  // "Ship-with-gap policy enforcement" section.
  const resumeWanted = (sessionIdForRow ?? "").length > 0;
  const descriptor = getAgentDescriptor(effectiveAgent);
  if (resumeWanted && descriptor && !descriptor.supports.resume) {
    throw new Error(
      `agent "${effectiveAgent}" does not support session resume — this run path needs it ` +
        `(intervene-resume / reuse-worktree). Switch the run to claude-code, or wait for the resume-fallback ` +
        `follow-up. See docs/internal/codex-parity.md.`,
    );
  }

  // Agent-level auth precheck: any registry entry can expose a `probeAuth`.
  // Codex uses this for its `~/.codex/auth.json` check; future harnesses
  // (kimi, qwen, …) plug in the same way. Claude-code has no probe — auth
  // is operator-managed and mid-run failures surface in the pane.
  if (descriptor?.probeAuth) {
    const auth = descriptor.probeAuth();
    if (auth && !auth.ok) {
      throw new Error(
        `${effectiveAgent} agent selected but not authenticated: ${auth.detail}. ` +
          (descriptor.authGuideText ?? "See the harness's docs to authenticate."),
      );
    }
  }

  await db.insert(schema.runs).values({
    id: runId,
    projectId: project.id,
    taskId: input.taskId ?? null,
    status: "queued",
    agentName: effectiveAgent,
    branch,
    worktreePath,
    startedAt: now,
    budgetSeconds: input.budgetSeconds ?? config.defaultRunBudgetSeconds,
    baseRef: baseRefSha,
    taskPlanId,
    operatorContext: operatorContext && operatorContext.length > 0 ? operatorContext : null,
    sessionId: sessionIdForRow ?? null,
    model: effectiveModel,
    retryOfRunId: input.retryOfRunId ?? null,
    releaseTag: input.releaseTag ?? null,
  });

  // A run is being submitted, so the project has work again — clear any
  // open queue-empty nudge so a stale "out of runway" card doesn't linger.
  const { resolveQueueEmptyNudges } = await import("../inbox/queue-empty.ts");
  await resolveQueueEmptyNudges(db, events, project.id);

  // Resume mode: explicit sessionId set, OR inherited via reuseFromRunId
  // when the source carried one. Either way the runner needs the flag.
  const resume =
    (sessionIdForRow ?? "").length > 0 && Boolean(input.reuseFromRunId || resumeSessionId);
  void pool.submit(async () => {
    await executeRun({ config, db, events, runs, pool }, runId, { resume });
  });

  return { runId };
}

/**
 * Re-submit an existing run for execution against the same Claude session.
 * Used by the boot-time reaper: if the prior daemon was interrupted while a
 * run was in flight, and the run row carries a `sessionId`, we'd rather
 * resume the conversation than throw the work away.
 */
export async function resumeOrphanedRun(deps: SubmitRunDeps, runId: string): Promise<void> {
  const { config, db, events, runs, pool } = deps;
  const row = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!row) throw new Error(`run not found: ${runId}`);
  if (!row.sessionId) throw new Error(`run ${runId} has no sessionId — cannot resume`);

  // Reset to queued so the worker picks it up cleanly. Keep the original
  // startedAt — the run is conceptually the same execution, not a new one.
  await db
    .update(schema.runs)
    .set({ status: "queued", endedAt: null })
    .where(eq(schema.runs.id, runId));

  void pool.submit(async () => {
    await executeRun({ config, db, events, runs, pool }, runId, { resume: true });
  });
}
