import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { WorkerPool } from "./pool.ts";
import type { RunRegistry } from "./registry.ts";
import { executeRun } from "./runner.ts";

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

  const runId = createId();
  const now = Date.now();
  const branch = `factory/run-${runId}`;
  const worktreePath = `${config.worktreesRoot}/${project.slug}/${runId}`;

  await db.insert(schema.runs).values({
    id: runId,
    projectId: project.id,
    taskId: input.taskId ?? null,
    status: "queued",
    agentName: "claude-code",
    branch,
    worktreePath,
    startedAt: now,
    budgetSeconds: input.budgetSeconds ?? config.defaultRunBudgetSeconds,
  });

  void pool.submit(async () => {
    await executeRun({ config, db, events, runs, pool }, runId);
  });

  return { runId };
}
