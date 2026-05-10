import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq } from "drizzle-orm";
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
  const branch = `factory/run-${runId}`;
  const worktreePath = `${config.worktreesRoot}/${project.slug}/${runId}`;

  const operatorContext = input.operatorContext?.trim();
  const resumeSessionId = input.resumeFromSessionId?.trim();

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
    taskPlanId,
    operatorContext: operatorContext && operatorContext.length > 0 ? operatorContext : null,
    sessionId: resumeSessionId && resumeSessionId.length > 0 ? resumeSessionId : null,
  });

  const resume = resumeSessionId !== undefined && resumeSessionId.length > 0;
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
