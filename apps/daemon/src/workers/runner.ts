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
import { listTasks, readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import {
  type FactoryStatus,
  parseFactoryStatus,
  wrapPrompt,
  wrapResumePrompt,
} from "./factory-status.ts";
import type { WorkerPool } from "./pool.ts";
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
 */
function runStatusFor(parsed: FactoryStatus | null, aborted: boolean): RunStatus {
  if (parsed) {
    switch (parsed.status) {
      case "done":
        return "completed";
      case "blocked":
        return "blocked";
      case "failed":
        return "failed";
    }
  }
  if (aborted) return "aborted";
  return "failed";
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
  const prompt = resuming ? wrapResumePrompt(baseTaskBody) : wrapPrompt(baseTaskBody);

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
      budgetSeconds: row.budgetSeconds || config.defaultRunBudgetSeconds,
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
        if (e.kind === "text") agentText += e.text;
        events.publish({ channel: "events", ...e });
        void persistEvent(e);
        if (e.kind === "session") lastSessionId = e.id;
      },
      logSocketPath: path.join(project.workdirPath, ".factory", "runs", runId, "log.txt"),
      tmuxSessionName: `factory-${project.slug}-${runId}`.slice(0, 60),
    });

    const aborted = ac.signal.aborted;
    const parsed = parseFactoryStatus(agentText);
    const finalStatus = runStatusFor(parsed, aborted);

    // If parsing returned null and the runtime spawn nonetheless emitted commits,
    // that's *some* signal of work done — but we deliberately keep this as
    // failed. The operator should see a blank status block as a bug to fix in
    // the prompt, not as a silent pass.
    const summary =
      parsed?.summary ||
      (finalStatus === "completed"
        ? "Run completed without an explicit summary."
        : finalStatus === "aborted"
          ? "Run was aborted by the operator."
          : "Run ended without a status block — the agent may have stopped early.");

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
        blockerQuestions:
          parsed?.questions && parsed.questions.length > 0
            ? JSON.stringify(parsed.questions)
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
    });

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
        // moved. The operator needs to know — without a decision here,
        // the run shows "completed" while main is empty. Approve = retry
        // the merge from this branch; dismiss = leave it on the branch.
        const decisionId = createId();
        await db.insert(schema.decisions).values({
          id: decisionId,
          kind: "merge_failure",
          projectId: project.id,
          outcome: `merge:${merge.reason}`,
          payload: {
            runId,
            taskId: row.taskId ?? null,
            branch: result.branch,
            reason: merge.reason,
            message: merge.message,
            summary,
          },
          status: "pending",
          createdAt: Date.now(),
        });
        events.publish({
          channel: "inbox",
          kind: "decision_created",
          decisionId,
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
      const questions = parsed?.questions ?? [];
      await db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId: project.id,
        outcome: "blocked",
        payload: {
          runId,
          taskId: row.taskId ?? null,
          summary,
          questions,
          branch: result.branch,
        },
        status: "pending",
        createdAt: Date.now(),
      });
      events.publish({
        channel: "inbox",
        kind: "decision_created",
        decisionId,
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
