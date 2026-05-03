import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { claudeCodeAgent, hostSandbox, type RuntimeEvent, runtime } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { readTaskFile } from "../projects/tasks.ts";
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
      task: { id: row.taskId ?? "ad-hoc", prompt },
      agent: claudeCodeAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: row.budgetSeconds || config.defaultRunBudgetSeconds,
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => {
        events.publish({ channel: "events", ...e });
        void persistEvent(e);
        if (e.kind === "session") lastSessionId = e.id;
      },
      logSocketPath: path.join(project.workdirPath, ".factory", "runs", runId, "log.txt"),
      tmuxSessionName: `factory-${project.slug}-${runId}`.slice(0, 60),
    });

    exitCode = result.exitCode;
    await db
      .update(schema.runs)
      .set({
        status: ac.signal.aborted ? "aborted" : exitCode === 0 ? "completed" : "failed",
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
  } catch (err) {
    await db
      .update(schema.runs)
      .set({
        status: "failed",
        endedAt: Date.now(),
        exitCode: 1,
      })
      .where(eq(schema.runs.id, runId));
    throw err;
  } finally {
    runs.unregister(runId);
  }
}
