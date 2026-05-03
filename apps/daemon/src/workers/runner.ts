import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { claudeCodeAgent, hostSandbox, type RuntimeEvent, runtime } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { readTaskFile, updateTaskStatus } from "../projects/tasks.ts";
import type { RunRegistry } from "./registry.ts";

export interface RunnerDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
}

export async function executeRun(deps: RunnerDeps, runId: string): Promise<void> {
  const { db, events, runs, config } = deps;

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

  // Reflect run lifecycle in the task file's frontmatter so the project view
  // shows the right chip without the operator refreshing manually. We tolerate
  // failures here — a missing task file shouldn't break the run.
  if (row.taskId) {
    try {
      await updateTaskStatus(project.workdirPath, row.taskId, "in_progress");
    } catch {
      // task file may not exist yet (ad-hoc invocations, deleted file)
    }
  }

  const paneEncoder = new TextEncoder();

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

  let prompt = row.taskId
    ? ((await readTaskFile(project.workdirPath, row.taskId))?.body ?? "")
    : "";
  if (!prompt) {
    prompt = `You are working on project "${project.name}". Pick the next ready task in .factory/work/ and execute it.`;
  }

  let lastSessionId: string | undefined;
  let exitCode = 0;

  try {
    const result = await runtime.spawn({
      runId,
      projectPath: project.workdirPath,
      worktreePath: row.worktreePath,
      gitAuthor: config.gitAuthor,
      task: { id: row.taskId ?? "ad-hoc", prompt },
      agent: claudeCodeAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: row.budgetSeconds || config.defaultRunBudgetSeconds,
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => {
        if (e.kind === "raw") {
          // raw lines are high-volume — fan out to pane subscribers only.
          events.publish({
            channel: "pane",
            runId: e.runId,
            bytes: paneEncoder.encode(`${e.line}\r\n`),
          });
          return;
        }
        events.publish({ channel: "events", ...e });
        void persistEvent(e);
        if (e.kind === "session") lastSessionId = e.id;
      },
      logSocketPath: path.join(project.workdirPath, ".factory", "runs", runId, "log.txt"),
      tmuxSessionName: `factory-${project.slug}-${runId}`.slice(0, 60),
    });

    exitCode = result.exitCode;
    const finalStatus = ac.signal.aborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
    await db
      .update(schema.runs)
      .set({
        status: finalStatus,
        endedAt: Date.now(),
        exitCode,
        sessionId: result.sessionId ?? lastSessionId ?? null,
        worktreePath: result.worktreePath,
        branch: result.branch,
        iterationCount: result.iterationsCompleted,
      })
      .where(eq(schema.runs.id, runId));

    await db
      .update(schema.projects)
      .set({ lastActivityAt: Date.now() })
      .where(eq(schema.projects.id, project.id));

    if (row.taskId) {
      const nextStatus =
        finalStatus === "completed" ? "done" : finalStatus === "aborted" ? "ready" : "blocked";
      try {
        await updateTaskStatus(project.workdirPath, row.taskId, nextStatus);
      } catch {
        // file may have been deleted during the run; ignore
      }
    }
  } catch (err) {
    await db
      .update(schema.runs)
      .set({
        status: "failed",
        endedAt: Date.now(),
        exitCode: 1,
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
