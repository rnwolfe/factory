import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { claudeCodeAgent, hostSandbox, type RuntimeEvent, runtime } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { listTasks, readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import { type FactoryStatus, parseFactoryStatus, wrapPrompt } from "./factory-status.ts";
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
 * declaration is authoritative — we never assume "done" when it didn't say so.
 */
function runStatusFor(parsed: FactoryStatus | null, aborted: boolean): RunStatus {
  if (aborted) return "aborted";
  if (!parsed) return "failed";
  switch (parsed.status) {
    case "done":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
  }
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

export async function executeRun(deps: RunnerDeps, runId: string): Promise<void> {
  const { db, events, runs, config, pool } = deps;

  const row = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!row) throw new Error(`run not found: ${runId}`);

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId))
    .get();
  if (!project) throw new Error(`project not found: ${row.projectId}`);

  const ac = new AbortController();
  runs.register(runId, ac);

  await db
    .update(schema.runs)
    .set({ status: "running", startedAt: Date.now(), iterationCount: 0 })
    .where(eq(schema.runs.id, runId));

  if (row.taskId) {
    try {
      await updateTaskStatus(project.workdirPath, row.taskId, "in_progress");
    } catch {
      // task file may not exist (ad-hoc, deleted)
    }
  }

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
  const prompt = wrapPrompt(baseTaskBody);

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
      strategy: { type: "head" },
      budgetSeconds: row.budgetSeconds || config.defaultRunBudgetSeconds,
      maxIterations: 1,
      abort: ac.signal,
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

    if (row.taskId) {
      try {
        await updateTaskStatus(project.workdirPath, row.taskId, taskStatusFor(finalStatus));
      } catch {
        // ignore
      }
    }

    events.publish({
      channel: "inbox",
      kind: "decision_updated", // reused — UI just invalidates queries
      decisionId: runId,
    });

    // Auto-advance: pick the next ready task and submit it. We dynamically
    // import to avoid a circular module dep with submit.ts (which imports
    // runner.ts).
    if (finalStatus === "completed" && project.autoAdvance) {
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
    if (row.taskId) {
      try {
        await updateTaskStatus(project.workdirPath, row.taskId, "blocked");
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    runs.unregister(runId);
  }
}
