import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import {
  claudeCodeAgent,
  commitAllChanges,
  hostSandbox,
  mergeIntoMain,
  type RuntimeEvent,
  runtime,
} from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, gt } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { parseStoredDraft } from "../plans/iterate.ts";
import { readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import { newAgentDecisionState, persistAgentDecisions } from "./agent-decisions.ts";
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
function runStatusFor(parsed: FactoryStatus | null, aborted: boolean): RunStatus {
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

  const taskFile = row.taskId ? await readTaskFile(project.workdirPath, row.taskId) : null;
  const taskBody = taskFile?.body ?? "";
  const taskTitle = taskFile?.frontmatter.title ?? null;
  const baseTaskBody =
    taskBody ||
    `You are working on project "${project.name}". Pick the next ready task in .factory/work/ and execute it.`;

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

  // Per-run state for the streaming agent-decision parser. Skipped entirely
  // in autonomous mode — the prompt forbids the agent from emitting decision
  // blocks at all, so even if one slips through we don't surface it. This
  // keeps the autonomy toggle a hard guarantee, not best-effort.
  const decisionState = newAgentDecisionState();
  const decisionsEnabled = autonomyMode === "collaborative";

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

  try {
    const result = await runtime.spawn({
      runId,
      projectPath: project.workdirPath,
      worktreePath: row.worktreePath,
      gitAuthor: config.gitAuthor,
      model: project.model,
      task: { id: row.taskId ?? "ad-hoc", prompt },
      agent: claudeCodeAgent,
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
          if (decisionsEnabled) {
            void persistAgentDecisions({
              db,
              events,
              runId,
              taskId: row.taskId ?? null,
              projectId: project.id,
              agentText,
              state: decisionState,
            }).catch(() => {
              // already logged inside persistAgentDecisions
            });
          }
        }
        if (e.kind === "metrics") {
          void recordClaudeMetrics({
            db,
            ownerKind: "run",
            ownerId: e.runId,
            projectId: project.id,
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
    if (decisionsEnabled) {
      try {
        await persistAgentDecisions({
          db,
          events,
          runId,
          taskId: row.taskId ?? null,
          projectId: project.id,
          agentText,
          state: decisionState,
        });
      } catch {
        // already logged
      }
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
    const finalStatus: RunStatus = capped
      ? "usage_capped"
      : defer
        ? "deferred"
        : runStatusFor(parsed, aborted);

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

    // If parsing returned null and the runtime spawn nonetheless emitted commits,
    // that's *some* signal of work done — but we deliberately keep this as
    // failed. The operator should see a blank status block as a bug to fix in
    // the prompt, not as a silent pass.
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

    // Stamp the task file's terminal status — but in the run's worktree, not
    // in the project's main tree. Committing it here means the upcoming
    // merge into main brings the status update along with the agent's work.
    // Skipped for deferred runs: the task is logically still in flight, and
    // the continuation run will write the terminal status when it lands.
    if (row.taskId && finalStatus !== "deferred" && finalStatus !== "usage_capped") {
      try {
        const updated = await updateTaskStatus(
          result.worktreePath,
          row.taskId,
          taskStatusFor(finalStatus),
        );
        if (updated) {
          await commitAllChanges(
            result.worktreePath,
            `chore: ${row.taskId} status -> ${updated.frontmatter.status}`,
            config.gitAuthor,
          );
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

    // Merge the run's branch back into the project's main so subsequent
    // tasks compound on top of it. Without this, every run starts from the
    // bootstrap commit and the project's main never advances — completed
    // work is invisible from the project root and auto-advance can't build
    // on prior tasks.
    let mergeFailureNote: string | null = null;
    if (finalStatus === "completed") {
      const taskId = row.taskId ?? "ad-hoc";
      const merge = await mergeIntoMain({
        projectPath: project.workdirPath,
        branch: result.branch,
        message: buildMergeMessage({ taskId, taskTitle, runId, summary, finalStatus }),
        author: config.gitAuthor,
      });
      if (merge.ok) {
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
    if (finalStatus === "blocked" || finalStatus === "failed") {
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
