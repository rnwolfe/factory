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
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { parseStoredDraft } from "../plans/iterate.ts";
import { listTasks, readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import { newAgentDecisionState, persistAgentDecisions } from "./agent-decisions.ts";
import {
  type AutonomyMode,
  type FactoryStatus,
  parseFactoryStatus,
  wrapPrompt,
  wrapPromptWithPlan,
  wrapResumePrompt,
  wrapResumePromptWithPlan,
} from "./factory-status.ts";
import { recordMergeFailure } from "./merge-failure.ts";
import type { WorkerPool } from "./pool.ts";
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

type RunStatus = (typeof schema.runStatusEnum)[number] extends string
  ? "queued" | "running" | "completed" | "failed" | "aborted" | "blocked"
  : never;

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

function taskStatusFor(runStatus: RunStatus): "ready" | "in_progress" | "done" | "blocked" {
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

  const taskBody = row.taskId
    ? ((await readTaskFile(project.workdirPath, row.taskId))?.body ?? "")
    : "";
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

  // Per-run state for the streaming agent-decision parser. Skipped entirely
  // in autonomous mode — the prompt forbids the agent from emitting decision
  // blocks at all, so even if one slips through we don't surface it. This
  // keeps the autonomy toggle a hard guarantee, not best-effort.
  const decisionState = newAgentDecisionState();
  const decisionsEnabled = autonomyMode === "collaborative";

  let lastSessionId: string | undefined;

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
      strategy: { type: "head", baseRef: row.baseRef ?? undefined },
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
    const finalStatus = runStatusFor(parsed, aborted);

    // If parsing returned null and the runtime spawn nonetheless emitted commits,
    // that's *some* signal of work done — but we deliberately keep this as
    // failed. The operator should see a blank status block as a bug to fix in
    // the prompt, not as a silent pass.
    const acceptanceDowngraded =
      parsed?.status === "done" && finalStatus === "blocked" && parsed.acceptance.length > 0;
    const baseSummary =
      parsed?.summary ||
      (finalStatus === "completed"
        ? "Run completed without an explicit summary."
        : finalStatus === "aborted"
          ? "Run was aborted by the operator."
          : "Run ended without a status block — the agent may have stopped early.");
    const summary = acceptanceDowngraded
      ? `${baseSummary}\n\n_Note: agent declared done but ${parsed.acceptance.filter((a) => !a.met).length} acceptance criterion(s) reported as unmet — downgraded to blocked._`
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
    if (row.taskId) {
      try {
        const updated = await updateTaskStatus(
          result.worktreePath,
          row.taskId,
          taskStatusFor(finalStatus),
        );
        if (updated) {
          await commitAllChanges(
            result.worktreePath,
            `factory: ${row.taskId} status -> ${updated.frontmatter.status}`,
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
        message: `factory: merge ${taskId} · run ${runId.slice(0, 8)}`,
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

    // Surface blocked runs to the decisions inbox. Without this the operator
    // has to navigate into the project to discover that a run stalled —
    // exactly the hidden-state failure the inbox-as-only-attention-sink
    // contract is supposed to prevent. Approving the resulting decision
    // triggers a retry from the source run's branch tip; dismissing leaves
    // the run blocked.
    if (finalStatus === "blocked") {
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

    // Auto-advance: pick the next ready task and submit it. We dynamically
    // import to avoid a circular module dep with submit.ts (which imports
    // runner.ts). Held when the merge into main failed — the next task
    // would start from a main that's missing this run's work, so any
    // dependency between tasks would silently break.
    if (finalStatus === "completed" && project.autoAdvance && !mergeFailureNote) {
      const tasks = await listTasks(project.workdirPath);
      const next = tasks.find((t) => t.frontmatter.status === "ready");
      if (next) {
        const { submitRun } = await import("./submit.ts");
        await submitRun(
          { config, db, events, runs, pool },
          { projectId: project.id, taskId: next.id },
        );
      }
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
