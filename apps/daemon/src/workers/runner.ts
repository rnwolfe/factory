import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import {
  type AgentSpec,
  claudeCodeAgent,
  commitAllChanges,
  hostSandbox,
  mergeIntoMain,
  type RuntimeEvent,
  removeWorktree,
  runtime,
} from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, gt } from "drizzle-orm";
import { type AgentName, getAgentDescriptor } from "../agents/registry.ts";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import { recordAutonomyEvent } from "../autonomy/events.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { resolveBotGitAuthor } from "../github/app-auth.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { parseStoredDraft } from "../plans/iterate.ts";
import { fetchIssueDiscussion, postIssueComment } from "../projects/github-task-store.ts";
import { readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import { newAgentDecisionState, persistAgentDecisions } from "./agent-decisions.ts";
import { type CrossModelVerdict, crossModelValidate, getRunDiff } from "./cross-model.ts";
import {
  type AutonomyMode,
  type FactoryStatus,
  parseFactoryDefer,
  parseFactoryStatus,
  prependOperatorContext,
  wrapPrompt,
  wrapPromptWithPlan,
  wrapResumePrompt,
  wrapResumePromptWithPlan,
} from "./factory-status.ts";
import { recordMergeFailure } from "./merge-failure.ts";
import type { WorkerPool } from "./pool.ts";
import { applyPostMergeRunOutcome, taskStatusFor } from "./post-merge.ts";
import { type QualityReport, runQualityChecks } from "./quality.ts";
import type { RunRegistry } from "./registry.ts";
import { evaluateTrustOnOutcome } from "./trust-ladder.ts";
import { classifyBlastRadius, computeVerifierReport, decideAutoLand } from "./verifier.ts";

export interface RunnerDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  /** Used by auto-advance to submit the next ready task on success. */
  pool: WorkerPool;
}

type RunStatus = (typeof schema.runStatusEnum)[number];

/**
 * Map a parsed factory-status to the run row's terminal status. The agent's
 * own declaration is authoritative when present — we trust the agent to
 * report `blocked` honestly, so we also trust it to report `done` honestly,
 * even if an abort signal fired afterward. `aborted` only wins when the
 * agent didn't manage to declare anything (e.g. operator killed it mid-run).
 *
 * Without this precedence, a graceful daemon shutdown (bun --watch reload,
 * SIGTERM, etc.) calls `runs.abortAll()` mid-run and discards completed
 * work. See the abort path in `apps/daemon/src/index.ts` `stop()`.
 *
 * Acceptance enforcement: when the agent declares `done` but its own
 * `acceptance` array reports any criterion as `met: false`, we downgrade
 * to `blocked`. The agent self-incriminated; we trust the structured
 * signal over the prose `status`. This keeps half-finished work out of
 * the auto-merge path.
 */
export function runStatusFor(
  parsed: FactoryStatus | null,
  aborted: boolean,
  opts: { hasCommits: boolean; exitCode: number } = { hasCommits: false, exitCode: 0 },
): RunStatus {
  if (parsed) {
    switch (parsed.status) {
      case "done": {
        const unmet = parsed.acceptance.filter((a) => !a.met);
        if (unmet.length > 0) return "blocked";
        return "completed";
      }
      case "blocked":
        return "blocked";
      case "failed":
        return "failed";
    }
  }
  if (aborted) return "aborted";
  // Null parse, but the agent exited cleanly AND left commits on the branch:
  // work provably landed (the codex code path reproduces the factory-status
  // footer less reliably than claude-code). Rather than discard committed
  // work as `failed`, route it to `needs_review` — preserved, not merged,
  // surfaced for the operator. A null parse with NO commits (or a non-zero
  // exit) stays `failed` exactly as before; the honesty contract is intact.
  if (opts.exitCode === 0 && opts.hasCommits) return "needs_review";
  return "failed";
}

/**
 * Build the questions list shown on the blocked-run decision card. When the
 * agent declared `done` but had unmet acceptance, surface the per-criterion
 * `reason` strings so the operator sees exactly which acceptance items
 * failed without having to drill into the full report.
 */
function blockerQuestionsFor(parsed: FactoryStatus | null, finalStatus: RunStatus): string[] {
  if (!parsed) return [];
  if (finalStatus !== "blocked") return [];
  const unmet = parsed.acceptance.filter((a) => !a.met);
  const fromAcceptance = unmet.map((a) =>
    a.reason
      ? `Unmet acceptance — ${a.criterion} (${a.reason})`
      : `Unmet acceptance — ${a.criterion}`,
  );
  return [...parsed.questions, ...fromAcceptance];
}

/**
 * Compose the merge commit that lands a completed run on the project's main.
 * The agent's own commits already carry the diff; this merge commit is the
 * record `git log main` shows. Conventional-commit subject built from the
 * task title, the run summary as the body, and machine-greppable `Factory-*`
 * trailers — so the merge node is a real summary of what the run did, not a
 * bare "merge run <id>" state transition.
 */
function buildMergeMessage(opts: {
  taskId: string;
  taskTitle: string | null;
  runId: string;
  summary: string;
  finalStatus: RunStatus;
}): string {
  const { taskId, taskTitle, runId, summary, finalStatus } = opts;
  const subject = taskTitle
    ? `chore(${taskId}): ${taskTitle.slice(0, 64)}`
    : `chore(${taskId}): land run ${runId.slice(0, 8)}`;
  return [
    subject,
    "",
    summary.trim(),
    "",
    `Factory-Run: ${runId}`,
    `Factory-Task: ${taskId}`,
    `Factory-Status: ${finalStatus}`,
  ].join("\n");
}

/**
 * Push a confirmed release to origin after its branch has merged into the
 * project's `main`. Runs from the project checkout (where `main` now carries
 * the release commit) and pushes `main` + the annotated `tag` the agent
 * created. Never throws — a push failure leaves the local release intact and is
 * reported back so the operator can push by hand. See ADR-008 + the runs-can't-
 * push lesson in tasks/lessons.md.
 */
export async function pushReleaseRefs(
  projectPath: string,
  tag: string,
): Promise<{ ok: boolean; note: string }> {
  const git = async (args: string[]) => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out: out.trim(), err: err.trim() };
  };

  const tagCheck = await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (tagCheck.code !== 0) {
    return {
      ok: false,
      note: `push skipped — tag ${tag} not found in the repo (the run did not create it). main was NOT pushed; cut/push the release by hand.`,
    };
  }
  const pushMain = await git(["push", "origin", "main"]);
  if (pushMain.code !== 0) {
    return {
      ok: false,
      note: `push failed — \`git push origin main\`: ${(pushMain.err || pushMain.out || "unknown").slice(0, 200)}`,
    };
  }
  const pushTag = await git(["push", "origin", tag]);
  if (pushTag.code !== 0) {
    return {
      ok: false,
      note: `main pushed, but tag ${tag} failed: ${(pushTag.err || pushTag.out || "unknown").slice(0, 200)} — push the tag by hand.`,
    };
  }
  return { ok: true, note: `pushed main + ${tag} to origin.` };
}

/**
 * Resolve the agent provider for a run row. Unknown agent names fall back to
 * claude-code so a typo in a task frontmatter or a future provider removal
 * never strands a queued run; the daemon logs the fallback for visibility.
 */
function agentForRow(agentName: string, worktreePath?: string | null): AgentSpec {
  const descriptor = getAgentDescriptor(agentName);
  if (!descriptor) {
    console.warn(
      `[runner] unknown agentName "${agentName}" on run row — falling back to claude-code`,
    );
  }
  // The worktree binding lives on the descriptor (runtimeSpecFor), so the runner
  // doesn't special-case any family — ADR-015.
  const resolved = descriptor ?? getAgentDescriptor("claude-code");
  const wt = worktreePath ?? undefined;
  return resolved?.runtimeSpecFor?.(wt) ?? resolved?.runtimeSpec ?? claudeCodeAgent;
}

export interface ExecuteRunOpts {
  /**
   * When true, invoke claude with `--resume <sessionId>` and a continuation
   * prompt instead of starting fresh. Used by the daemon-restart recovery
   * path so an interrupted run can pick up its prior conversation rather
   * than discard the work.
   */
  resume?: boolean;
}

export async function executeRun(
  deps: RunnerDeps,
  runId: string,
  opts: ExecuteRunOpts = {},
): Promise<void> {
  const { db, events, runs, config, pool } = deps;

  const row = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!row) throw new Error(`run not found: ${runId}`);

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId))
    .get();
  if (!project) throw new Error(`project not found: ${row.projectId}`);

  const resuming = opts.resume === true && Boolean(row.sessionId);

  const ac = new AbortController();
  runs.register(runId, ac);

  await db
    .update(schema.runs)
    .set({ status: "running", iterationCount: 0 })
    .where(eq(schema.runs.id, runId));

  // We deliberately do NOT write `in_progress` to the task file in main
  // here. The run row's `status="running"` is the canonical signal that
  // a task is in flight; the projects router enriches task listings with
  // it. Writing to main would dirty the project tree and block the
  // post-run merge. The terminal status write below goes to the worktree
  // so it rides the merge back into main.

  const paneEncoder = new TextEncoder();
  let agentText = "";

  const persistEvent = async (e: RuntimeEvent) => {
    try {
      await db.insert(schema.events).values({
        runId: e.runId,
        iteration: e.iteration,
        ts: Date.now(),
        kind: e.kind,
        payload: e,
      });
    } catch {
      // never let event persistence break a run
    }
  };

  const taskFile = row.taskId ? await readTaskFile(project, row.taskId) : null;
  const taskBody = taskFile?.body ?? "";
  const taskTitle = taskFile?.frontmatter.title ?? null;
  // When there's no task body, fall back to the "pick the next ready task"
  // default — UNLESS the run carries operator context that fully drives it
  // (e.g. a skills.submit run, whose directive is the whole instruction). In
  // that case an empty base body keeps the prepended directive authoritative
  // instead of stapling a contradictory "go find a task" sentence after it.
  const operatorDriven = (row.operatorContext ?? "").trim().length > 0;
  let baseTaskBody =
    taskBody ||
    (operatorDriven
      ? ""
      : `You are working on project "${project.name}". Pick the next ready task in .factory/work/ and execute it.`);

  // Fold the GitHub issue thread into the prompt as first-class context for
  // github-backed tasks (ADR-007). Best-effort and delimited as untrusted; "" for
  // file-backed projects or on any error, so it never blocks a run.
  if (row.taskId) {
    const discussion = await fetchIssueDiscussion(config, project, row.taskId);
    if (discussion) baseTaskBody = `${baseTaskBody}\n\n${discussion}`;
  }

  // Plan-aware prompt: if the run has a frozen task_plan attached, fold its
  // draft into the prompt as authoritative context. Resume prompts get the
  // same plan injection — the recovered Claude session may have lost the
  // original plan block from its context, and we don't want a resumed agent
  // improvising past the operator-approved scope.
  let frozenTaskPlan: ReturnType<typeof parseStoredDraft> | null = null;
  if (row.taskPlanId) {
    const planRow = await db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, row.taskPlanId))
      .get();
    if (planRow && planRow.status === "frozen" && planRow.kind === "task_plan") {
      try {
        const draft = parseStoredDraft(planRow.draft);
        if (draft.kind === "task_plan") frozenTaskPlan = draft;
      } catch {
        // Plan draft unparseable — fall back to plan-less prompt rather than
        // failing the run. The run summary will still mention the attached
        // plan id for audit.
      }
    }
  }

  const autonomyMode: AutonomyMode = project.autonomyMode ?? "collaborative";

  // NB: operator-memory is deliberately NOT injected into runs here. It's
  // cross-project, so a blanket pointer over-corrects — e.g. the operator's
  // "Go + kong for CLIs" preference bleeding into a TypeScript project. Memory
  // reaches work through two SCOPED channels instead: (a) gated work proposals
  // (synthesize → insight → tasks/bugs/process), and (b) project-scoped direction
  // (a project's own AGENTS.md). The `contextRefs` seam below stays for (b) once
  // facts carry project scope. See ADR-010 §4 / tasks/todo.md.
  let prompt: string;
  if (resuming) {
    prompt =
      frozenTaskPlan && frozenTaskPlan.kind === "task_plan"
        ? wrapResumePromptWithPlan(baseTaskBody, frozenTaskPlan, autonomyMode)
        : wrapResumePrompt(baseTaskBody, autonomyMode);
  } else if (frozenTaskPlan && frozenTaskPlan.kind === "task_plan") {
    prompt = wrapPromptWithPlan(row.taskId ?? "ad-hoc", baseTaskBody, frozenTaskPlan, autonomyMode);
  } else {
    prompt = wrapPrompt(baseTaskBody, autonomyMode);
  }

  // If this run was submitted with operator context (the blocked-run retry
  // path gathers comments from the decision thread), prepend it so the
  // agent reads the operator's answers before the task body. Skipped on
  // resume — the resumed Claude session already has the prior conversation
  // in context, and the operator's reply is delivered as the new user turn
  // implicitly via the run's session continuation.
  if (!resuming && row.operatorContext && row.operatorContext.trim().length > 0) {
    prompt = prependOperatorContext(prompt, row.operatorContext);
  }

  // Per-run state for the streaming agent-decision parser. Trust Ladder
  // (ADR-012): the agent always emits `factory-decision` forks; the autonomy
  // level decides only how they're recorded — L1 (collaborative) surfaces them
  // as PENDING ratification cards; L2+ (autonomous) auto-ratifies them
  // (`auto_ratified`: out of the pending inbox, kept in history, still
  // overridable). The run never pauses on a fork either way.
  const decisionState = newAgentDecisionState();
  const autoRatifyDecisions = autonomyMode !== "collaborative";

  let lastSessionId: string | undefined;
  // No initializer: an `= null` start would let control-flow analysis narrow
  // this to `null` (the assignment below lives in the onEvent closure, which
  // CFA does not see), breaking the type at the post-spawn use sites.
  let usageLimit: { resetsAt: number | null; message: string } | undefined;

  // Reuse vs. fresh detection: a fresh run's branch is `factory/run-<runId>`
  // by convention. When the row's branch deviates, the run was submitted
  // with `reuseFromRunId` and is operating on an existing worktree+branch
  // (e.g. the intervene-resume path keeps the agent's gitignored data
  // intact). Use a "branch" strategy so the runtime attaches to the
  // existing branch rather than trying to create a new one.
  const expectedFreshBranch = `factory/run-${runId}`;
  const isReusedWorktree = row.branch !== expectedFreshBranch;
  const runStrategy = isReusedWorktree
    ? { type: "branch" as const, name: row.branch, baseRef: row.baseRef ?? undefined }
    : { type: "head" as const, baseRef: row.baseRef ?? undefined };

  // Bot identity (ADR-007 §D2): when the Factory App is configured AND installed
  // on this project's repo, commits attribute to `factory[bot]`. Defensive and
  // inert otherwise — `resolveBotGitAuthor` returns null (no network) when the
  // App is unconfigured, so this is exactly today's behaviour until credentials
  // are provided.
  const botAuthor = await resolveBotGitAuthor(config, project.githubRemote ?? null);

  try {
    const result = await runtime.spawn({
      runId,
      projectPath: project.workdirPath,
      worktreePath: row.worktreePath,
      requireExistingWorktree: isReusedWorktree,
      gitAuthor: botAuthor ?? config.gitAuthor,
      // The effective model was resolved at submit time per the
      // task → project → system-default inheritance chain. Falling back
      // to project.model here is a safety net for legacy rows that
      // predate the runs.model column.
      model: row.model ?? project.model,
      task: { id: row.taskId ?? "ad-hoc", prompt },
      agent: agentForRow(row.agentName, row.worktreePath),
      sandbox: hostSandbox,
      strategy: runStrategy,
      // row.budgetSeconds is NOT NULL; preserve 0 (= infinite) instead of
      // collapsing to the default via `||`.
      budgetSeconds: row.budgetSeconds,
      maxIterations: 1,
      abort: ac.signal,
      resume: resuming && row.sessionId ? { sessionId: row.sessionId } : undefined,
      onEvent: (e) => {
        if (e.kind === "raw") {
          events.publish({
            channel: "pane",
            runId: e.runId,
            bytes: paneEncoder.encode(`${e.line}\r\n`),
          });
          return;
        }
        if (e.kind === "text") {
          agentText += e.text;
          // Streaming parse for `factory-decision` blocks. Fire-and-forget
          // — failures shouldn't disturb the run, and the parser is
          // idempotent so a final pass after the run also catches missed
          // decisions. We pass the projectId from the closure (project
          // is loaded above; runs without a project are a runner bug).
          void persistAgentDecisions({
            db,
            events,
            runId,
            taskId: row.taskId ?? null,
            projectId: project.id,
            agentText,
            state: decisionState,
            autoRatify: autoRatifyDecisions,
          }).catch(() => {
            // already logged inside persistAgentDecisions
          });
        }
        if (e.kind === "metrics") {
          void recordAgentMetrics({
            db,
            ownerKind: "run",
            ownerId: e.runId,
            projectId: project.id,
            agent: row.agentName,
            metrics: e.metrics,
          });
        }
        events.publish({ channel: "events", projectId: project.id, ...e });
        void persistEvent(e);
        if (e.kind === "session") lastSessionId = e.id;
        if (e.kind === "usage_limit") {
          usageLimit = { resetsAt: e.resetsAt, message: e.message };
        }
      },
      logSocketPath: path.join(project.workdirPath, ".factory", "runs", runId, "log.txt"),
      tmuxSessionName: `factory-${project.slug}-${runId}`.slice(0, 60),
    });

    const aborted = ac.signal.aborted;

    // Final agent-decision pass: catches any block whose closing fence
    // arrived in the same text event as the factory-status block (rare but
    // possible) and any block missed by streaming due to in-flight races.
    // Idempotent via state.processedIds — already-persisted ids are a no-op.
    try {
      await persistAgentDecisions({
        db,
        events,
        runId,
        taskId: row.taskId ?? null,
        projectId: project.id,
        agentText,
        state: decisionState,
        autoRatify: autoRatifyDecisions,
      });
    } catch {
      // already logged
    }

    const parsed = parseFactoryStatus(agentText);
    const defer = aborted ? null : parseFactoryDefer(agentText);
    // factory-defer wins over factory-status. If the agent emitted both
    // (against the protocol's instruction), we treat the deferred work
    // as the load-bearing signal — the agent was about to ask Factory to
    // run something that outlives the turn, and silently dropping the
    // defer would lose that work entirely. We log this case for the
    // operator's awareness via the run summary below.
    // A usage-cap exit (the account hit its quota mid-run) is not a failure:
    // the agent was cut off by an external limit, its work-so-far is valid,
    // and its session is resumable. It outranks `defer`/parsed status, but
    // not an operator abort — explicit intent wins.
    const capped = !aborted && usageLimit != null;
    // `let`, not `const`: the verifier gate (ADR-014) may downgrade an autonomous
    // `completed` run to `needs_review` after quality + cross-model run below. The
    // merge / surface / auto-advance blocks all read this variable downstream, so the
    // single reassignment routes the whole tail correctly — same trick as the
    // acceptance downgrade, just later in the pipeline.
    let finalStatus: RunStatus = capped
      ? "usage_capped"
      : defer
        ? "deferred"
        : runStatusFor(parsed, aborted, {
            hasCommits: result.commits.length > 0,
            exitCode: result.exitCode,
          });

    // Usage-cap resolution. Auto-resume at the parsed reset time when we have
    // one and the cap hasn't already recurred for this task; otherwise fall
    // back to a blocked_run decision so the operator resumes on their own
    // schedule. `priorCaps` bounds the auto-resume chain to two automatic
    // attempts before handing off.
    let resumeAt: number | null = null;
    let capFallbackDecision = false;
    if (capped) {
      const priorCaps =
        row.taskId != null
          ? (
              await db
                .select({ id: schema.runs.id })
                .from(schema.runs)
                .where(
                  and(
                    eq(schema.runs.projectId, project.id),
                    eq(schema.runs.taskId, row.taskId),
                    eq(schema.runs.status, "usage_capped"),
                    gt(schema.runs.startedAt, Date.now() - 12 * 60 * 60 * 1000),
                  ),
                )
                .all()
            ).length
          : 0;
      if (usageLimit && usageLimit.resetsAt != null && priorCaps < 2) {
        resumeAt = usageLimit.resetsAt;
      } else {
        capFallbackDecision = true;
      }
    }

    // Null parse + clean exit + commits resolves to `needs_review` (see
    // runStatusFor) — work landed, so we preserve and surface it instead of
    // discarding it as `failed`. Null parse with no commits still fails.
    const acceptanceDowngraded =
      parsed?.status === "done" && finalStatus === "blocked" && parsed.acceptance.length > 0;
    const baseSummary = capped
      ? `${usageLimit?.message ?? "Hit the account usage limit."} ${
          resumeAt != null
            ? `Auto-resume scheduled for ${new Date(resumeAt).toLocaleString()}.`
            : "Surfaced as a decision — approve to resume the session."
        }`
      : defer
        ? `Deferred: ${defer.summary}${
            parsed
              ? `\n\n_Note: agent emitted both factory-defer and factory-status (${parsed.status}); deferred work takes precedence._`
              : ""
          }`
        : parsed?.summary ||
          (finalStatus === "completed"
            ? "Run completed without an explicit summary."
            : finalStatus === "aborted"
              ? "Run was aborted by the operator."
              : finalStatus === "needs_review"
                ? "Agent exited cleanly with commits but emitted no factory-status footer — work is preserved on the run branch for review (not merged)."
                : "Run ended without a status block — the agent may have stopped early.");
    const summary = acceptanceDowngraded
      ? `${baseSummary}\n\n_Note: agent declared done but ${parsed?.acceptance.filter((a) => !a.met).length ?? 0} acceptance criterion(s) reported as unmet — downgraded to blocked._`
      : baseSummary;
    const blockerQuestions = blockerQuestionsFor(parsed, finalStatus);

    await db
      .update(schema.runs)
      .set({
        status: finalStatus,
        endedAt: Date.now(),
        exitCode: result.exitCode,
        sessionId: result.sessionId ?? lastSessionId ?? null,
        worktreePath: result.worktreePath,
        branch: result.branch,
        iterationCount: result.iterationsCompleted,
        summary,
        resumeAt,
        blockerQuestions: blockerQuestions.length > 0 ? JSON.stringify(blockerQuestions) : null,
        acceptanceResults:
          parsed?.acceptance && parsed.acceptance.length > 0
            ? JSON.stringify(parsed.acceptance)
            : null,
      })
      .where(eq(schema.runs.id, runId));

    await db
      .update(schema.projects)
      .set({ lastActivityAt: Date.now() })
      .where(eq(schema.projects.id, project.id));

    // Close any open dialog intervention this run was the retry for (task-049),
    // stamping its terminal status as the outcome. No-op when this run wasn't a
    // blocker→reply→re-run retry.
    try {
      const { interventionLog } = await import("../interventions/log.ts");
      await interventionLog(db).closeDialogForRetry(runId, finalStatus);
    } catch (err) {
      console.warn(
        `[intervention-log] close for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Stamp the task file's terminal status — but in the run's worktree, not
    // in the project's main tree. Committing it here means the upcoming
    // merge into main brings the status update along with the agent's work.
    // Skipped for deferred runs: the task is logically still in flight, and
    // the continuation run will write the terminal status when it lands.
    // File-backed only: the terminal status is written into the worktree so it
    // rides the merge into main. github-backed projects update the issue via
    // the API in post-merge instead (no file to write/commit here).
    if (
      project.taskBackend !== "github-issues" &&
      row.taskId &&
      finalStatus !== "deferred" &&
      finalStatus !== "usage_capped"
    ) {
      try {
        const updated = await updateTaskStatus(
          { workdirPath: result.worktreePath },
          row.taskId,
          taskStatusFor(finalStatus),
        );
        if (updated) {
          const committed = await commitAllChanges(
            result.worktreePath,
            `chore: ${row.taskId} status -> ${updated.frontmatter.status}`,
            botAuthor ?? config.gitAuthor,
          );
          // We just wrote the task file; if the commit produced nothing,
          // .factory/work/ is gitignored. The merge will bring no task-
          // status update to main and the task stays at its prior value.
          // Logged loudly because the silent-no-op cost us 7 stuck tasks
          // before we caught it. Fix: unignore .factory/work/ in the
          // project's .gitignore (only .factory/runs/ should be ignored).
          if (!committed) {
            console.warn(
              `[runner] task-status commit was empty for ${row.taskId} in ${result.worktreePath} — .factory/work/ likely gitignored on this project; status will not propagate to main`,
            );
          }
        }
      } catch {
        // task file may not be present (ad-hoc run); commit may be a no-op.
      }
    }

    events.publish({
      channel: "inbox",
      kind: "decision_updated", // reused — UI just invalidates queries
      decisionId: runId,
      projectId: project.id,
    });

    // Hand off long-running work to the daemon-supervised deferred-task
    // primitive. The agent's `factory-defer` block told us "run X, then
    // resume me with the result" — Factory now owns that bridge between
    // claude --print invocations. Quality / merge / auto-advance below
    // all naturally skip when finalStatus === "deferred"; the continuation
    // run will land on the same worktree+branch via reuseFromRunId and
    // will go through those checks itself once the agent declares done.
    if (finalStatus === "deferred" && defer) {
      const { spawnDeferredTask } = await import("../deferred-tasks/orchestrate.ts");
      try {
        const { deferredTaskId } = await spawnDeferredTask(
          { config, db, events, runs, pool },
          {
            id: runId,
            projectId: project.id,
            taskId: row.taskId ?? null,
            worktreePath: result.worktreePath,
            branch: result.branch,
          },
          defer,
        );
        await db
          .update(schema.runs)
          .set({ summary: `${summary}\n\n_Deferred task id: ${deferredTaskId}_` })
          .where(eq(schema.runs.id, runId));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[runner] failed to spawn deferred task for ${runId}: ${msg}`);
        // Demote: spawn failed, so the run cannot legitimately be deferred.
        // Mark it failed so the operator notices instead of seeing a run
        // stuck in `deferred` forever.
        await db
          .update(schema.runs)
          .set({
            status: "failed",
            summary: `${summary}\n\n[deferred-spawn] failed to start: ${msg}`,
          })
          .where(eq(schema.runs.id, runId));
      }
    }

    // Quality signal: run lint/typecheck/test inside the worktree after the
    // agent's auto-commit and before merging into main. Failures do NOT
    // block the merge in v0.2 — the report is informational. Persisted on
    // the run row + broadcast on /ws/events so the live pane re-renders.
    let qualityReport: QualityReport | null = null;
    if (finalStatus === "completed") {
      try {
        qualityReport = await runQualityChecks({
          worktreePath: result.worktreePath,
          configPath: path.join(project.workdirPath, ".factory", "quality.yaml"),
        });
        if (qualityReport.results.length > 0 || qualityReport.overall !== "skipped") {
          await db
            .update(schema.runs)
            .set({ qualityReport: JSON.stringify(qualityReport) })
            .where(eq(schema.runs.id, runId));
          events.publish({
            channel: "events",
            kind: "quality_report",
            runId,
            iteration: 1,
            overall: qualityReport.overall,
            projectId: project.id,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[runner] quality checks failed for ${runId}: ${message}`);
        // Persist a minimal failure report so the operator sees the error
        // without the run silently appearing pristine.
        const report: QualityReport = {
          ranAt: Date.now(),
          results: [
            {
              name: "config",
              command: "(loading quality.yaml)",
              exitCode: 1,
              durationMs: 0,
              stdoutTail: "",
              stderrTail: message,
              timedOut: false,
            },
          ],
          overall: "fail",
        };
        qualityReport = report;
        await db
          .update(schema.runs)
          .set({ qualityReport: JSON.stringify(report) })
          .where(eq(schema.runs.id, runId));
      }
    }

    // Verifier-Coverage report (ADR-014, WS C): measure how much actually
    // VERIFIED this run — acceptance coverage + quality coverage — so
    // "completed" is no longer conflated with "verified." Informational for
    // now: it is persisted (and will feed the future auto-land gate) but does
    // NOT hold back the merge below. `absent` signals score zero on purpose.
    if (finalStatus === "completed") {
      // WS D — cross-model adversarial validation: route verification to the OTHER
      // model family (claude↔codex), the strongest input to the score. Gated to
      // autonomous-mode projects, since it's a full second-model call and that's
      // where the auto-merge actually needs the extra verifier; collaborative runs
      // keep the 2-signal score. `undefined` here = "not run" (excluded from score).
      let crossModel: CrossModelVerdict | null | undefined;
      let diff = "";
      if (autonomyMode === "autonomous") {
        diff = await getRunDiff(result.worktreePath, row.baseRef);
        crossModel = await crossModelValidate(
          {
            builderAgent: row.agentName as AgentName,
            diff,
            acceptance: parsed?.acceptance ?? [],
            taskTitle: taskTitle ?? row.taskId ?? "task",
            summary,
          },
          { cwd: result.worktreePath, budgetSeconds: 180 },
        );
      }
      const verifierReport = computeVerifierReport({
        acceptance: parsed?.acceptance ?? [],
        qualityReport,
        crossModel,
      });
      await db
        .update(schema.runs)
        .set({ verifierReport: JSON.stringify(verifierReport) })
        .where(eq(schema.runs.id, runId));

      // The gate (ADR-014 slice 2). For AUTONOMOUS runs only: auto-land silently
      // when verified + contained; otherwise downgrade to `needs_review` so the
      // tail (merge / surface / auto-advance) holds it for the operator instead of
      // merging. Collaborative runs are unchanged — they merge on `completed` as in
      // v0.1 (the operator is already in the loop).
      if (autonomyMode === "autonomous") {
        const blast = classifyBlastRadius(diff);
        const gate = decideAutoLand(verifierReport, blast);
        if (!gate.land) {
          finalStatus = "needs_review";
          await db
            .update(schema.runs)
            .set({
              status: "needs_review",
              summary: `${summary}\n\n_Verifier gate held this run for review — ${gate.reason}._`,
            })
            .where(eq(schema.runs.id, runId));
          recordAutonomyEvent(db, events, {
            kind: "gate_held",
            projectId: project.id,
            runId,
            message: `${project.name} run held for review — ${gate.reason}`,
            detail: { verifierReport },
          });
        }
      }
    }

    // Merge the run's branch back into the project's main so subsequent
    // tasks compound on top of it. Without this, every run starts from the
    // bootstrap commit and the project's main never advances — completed
    // work is invisible from the project root and auto-advance can't build
    // on prior tasks.
    let mergeFailureNote: string | null = null;
    let mergeSha: string | null = null;
    if (finalStatus === "completed") {
      const taskId = row.taskId ?? "ad-hoc";
      const merge = await mergeIntoMain({
        projectPath: project.workdirPath,
        branch: result.branch,
        message: buildMergeMessage({ taskId, taskTitle, runId, summary, finalStatus }),
        author: botAuthor ?? config.gitAuthor,
      });
      if (merge.ok) {
        mergeSha = merge.sha;
        if (!merge.alreadyMerged) {
          events.publish({
            channel: "events",
            kind: "commit",
            runId,
            iteration: 1,
            sha: merge.sha,
            subject: `merge to main: ${result.branch}`,
            projectId: project.id,
          });
        }
        // Worktree is now redundant: the agent's work lives on main via
        // the merge commit, and the run's branch ref still points at
        // the pre-merge tip if the operator wants to inspect via
        // `git log <branch>`. Removing just the working directory
        // reclaims disk; the branch ref stays for history.
        //
        // Without this, every completed run leaves its worktree on disk
        // forever (the runtime's existing cleanup only triggers on
        // commits.length === 0). After weeks of use the worktrees dir
        // becomes the largest thing in ~/.factory.
        try {
          await removeWorktree({
            projectPath: project.workdirPath,
            worktreePath: result.worktreePath,
          });
        } catch (err) {
          // Best-effort. If the worktree is gone or git is wedged on it,
          // the operator can clean up manually; the merge already
          // succeeded so the run is otherwise complete.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[runner] worktree cleanup failed for ${runId}: ${msg}`);
        }

        // Release runs push to origin AFTER the merge, from the project
        // checkout — the run's worktree had a stale `main` (its release commit
        // lived on the run branch until this merge). The agent created the
        // annotated tag named after the confirmed version; push `main` + that
        // tag now. Failures are surfaced in the run summary, not thrown — the
        // local release is intact and the operator can push by hand.
        if (row.releaseTag) {
          const push = await pushReleaseRefs(project.workdirPath, row.releaseTag);
          console.log(`[runner] ${runId} release push: ${push.note}`);
          await db
            .update(schema.runs)
            .set({ summary: `${summary}\n\n[release] ${push.note}` })
            .where(eq(schema.runs.id, runId));
        }
      } else {
        mergeFailureNote = `[merge] ${merge.reason}: ${merge.message}`;
        console.warn(`[runner] merge to main failed for ${runId}: ${mergeFailureNote}`);
        await db
          .update(schema.runs)
          .set({ summary: `${summary}\n\n${mergeFailureNote}` })
          .where(eq(schema.runs.id, runId));

        // The agent's work is sitting on `result.branch` but main hasn't
        // moved. Surface a decision so the operator can approve = retry
        // or dismiss = leave on the branch. Same primitive sessions use.
        await recordMergeFailure(db, events, {
          projectId: project.id,
          reason: merge.reason,
          message: merge.message,
          payload: {
            runId,
            taskId: row.taskId ?? null,
            branch: result.branch,
            reason: merge.reason,
            message: merge.message,
            summary,
          },
        });
      }
    }

    // Trust Ladder auto-movement (ADR-012 Slice 2): the project's level moves
    // itself on this outcome — contract autonomous→collaborative on a failure or
    // merge conflict, ratchet collaborative→autonomous on a clean verifier-green
    // completion. (A held `needs_review` run is the gate working, so it's neutral.)
    const trustMove = evaluateTrustOnOutcome(
      db,
      { id: project.id, name: project.name, autonomyMode },
      { finalStatus, mergeConflict: mergeFailureNote !== null },
      resolveAutonomyConfig(db, project.id),
    );
    if (trustMove === "contracted") {
      recordAutonomyEvent(db, events, {
        kind: "trust_contracted",
        projectId: project.id,
        runId,
        message: `${project.name} paused to collaborative — ${mergeFailureNote ? "merge conflict" : "run failed"}`,
      });
    } else if (trustMove === "promoted") {
      recordAutonomyEvent(db, events, {
        kind: "trust_promoted",
        projectId: project.id,
        runId,
        message: `${project.name} earned autonomous mode (clean track record)`,
      });
    }

    // Surface stalled runs (blocked or failed) to the decisions inbox.
    // Without this the operator has to navigate into the project to discover
    // that a run died — exactly the hidden-state failure the inbox-as-only-
    // attention-sink contract is supposed to prevent. Approving the resulting
    // decision triggers a retry from the source run's branch tip (picking up
    // any auto-committed partial work); dismissing leaves it stranded.
    //
    // `usage_capped` has its own resolution path above (auto-resume or
    // `capFallbackDecision`), and `deferred`/`aborted`/`completed` don't need
    // operator attention — so we only surface the two stuck terminal states.
    if (finalStatus === "blocked" || finalStatus === "failed" || finalStatus === "needs_review") {
      const decisionId = createId();
      await db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId: project.id,
        outcome: "blocked",
        payload: {
          runId,
          taskId: row.taskId ?? null,
          summary,
          questions: blockerQuestions,
          branch: result.branch,
          // Distinguish a failed run (no factory-status footer, agent died
          // mid-thought, etc.) from a blocked run (agent self-declared
          // blocked with questions). Same retry mechanics; different framing
          // in the inbox card and decision detail.
          ...(finalStatus === "failed" ? { failed: true } : {}),
          // needs_review: agent exited cleanly with committed work but no
          // footer. The branch holds reviewable commits — the operator can
          // inspect and merge, or retry — so the card frames it as "review",
          // not "failed".
          ...(finalStatus === "needs_review" ? { needsReview: true } : {}),
        },
        status: "pending",
        createdAt: Date.now(),
      });
      events.publish({
        channel: "inbox",
        kind: "decision_created",
        decisionId,
        projectId: project.id,
      });
    }

    // Usage-cap fallback: when we can't safely auto-resume (no parseable
    // reset time, or the cap kept recurring), surface a blocked_run decision
    // flagged `usageCapped` so the operator resumes on their own schedule.
    // Approving it resumes the same session via reuseFromRunId — see the
    // blocked_run handler in routers/decisions.ts.
    if (capped && capFallbackDecision) {
      const decisionId = createId();
      await db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId: project.id,
        outcome: "blocked",
        payload: {
          runId,
          taskId: row.taskId ?? null,
          summary,
          questions: [],
          branch: result.branch,
          usageCapped: true,
        },
        status: "pending",
        createdAt: Date.now(),
      });
      events.publish({
        channel: "inbox",
        kind: "decision_created",
        decisionId,
        projectId: project.id,
      });
    }

    // Auto-advance + defensive task-status reconcile, via the shared helper
    // that decisions.ts and interventions/orchestrate.ts also call on the
    // operator-approved retry paths. Held when the merge into main failed —
    // the next task would start from a main that's missing this run's work,
    // so any dependency between tasks would silently break. The held
    // advance fires from the same helper once the operator resolves.
    // Writeback: report the run outcome into the issue thread (github-backed
    // tasks), closing the loop with the same thread the agent read from. Self-
    // gates to github backends (no-op for file-backed) and is best-effort.
    if (
      row.taskId &&
      (finalStatus === "completed" ||
        finalStatus === "blocked" ||
        finalStatus === "failed" ||
        finalStatus === "needs_review")
    ) {
      const icon =
        finalStatus === "completed"
          ? "✅"
          : finalStatus === "blocked"
            ? "⏸️"
            : finalStatus === "needs_review"
              ? "🔍"
              : "❌";
      const lines = [`${icon} **Run ${finalStatus}** \`${runId.slice(0, 8)}\``, "", summary.trim()];
      if (mergeSha) lines.push("", `Merged to \`main\`: \`${mergeSha.slice(0, 10)}\``);
      if (qualityReport && qualityReport.overall !== "skipped") {
        lines.push("", `Quality: **${qualityReport.overall}**`);
      }
      if (blockerQuestions.length > 0) {
        lines.push("", "**Questions:**", ...blockerQuestions.map((q) => `- ${q}`));
      }
      lines.push("", "<!-- factory:run -->");
      await postIssueComment(config, project, row.taskId, lines.join("\n"));
    }

    if (finalStatus === "completed" && !mergeFailureNote) {
      await applyPostMergeRunOutcome({ config, db, events, runs, pool }, runId);
    }
  } catch (err) {
    await db
      .update(schema.runs)
      .set({
        status: "failed",
        endedAt: Date.now(),
        exitCode: 1,
        summary: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.runs.id, runId));
    // The run failed before/during spawn; the worktree may or may not exist.
    // Don't touch main — that would dirty the tree. The DB run row already
    // tells the projects router to surface this task as blocked via the
    // run-derived enrichment. If a worktree exists we silently leave it for
    // post-mortem inspection.
    throw err;
  } finally {
    runs.unregister(runId);
  }
}
