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
  /**
   * When set, the new worktree is created from this ref instead of project
   * HEAD. Used by the retry path: pass the source run's branch so the new
   * agent invocation picks up its predecessor's auto-commit + partial work.
   */
  baseRef?: string;
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
    baseRef: input.baseRef ?? null,
  });

  void pool.submit(async () => {
    await executeRun({ config, db, events, runs, pool }, runId);
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
