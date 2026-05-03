import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { executeRun } from "../workers/runner.ts";

export const runsRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.projectId, input.projectId))
        .orderBy(desc(schema.runs.startedAt))
        .limit(100)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(schema.runs).where(eq(schema.runs.id, input.id)).get() ?? null;
  }),

  start: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string().optional(),
        prompt: z.string().optional(),
        budgetSeconds: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");

      const runId = createId();
      const now = Date.now();
      const branch = `factory/run-${runId}`;
      await ctx.db.insert(schema.runs).values({
        id: runId,
        projectId: project.id,
        taskId: input.taskId ?? null,
        status: "queued",
        agentName: "claude-code",
        branch,
        worktreePath: `${project.workdirPath}/worktrees/${branch}`,
        startedAt: now,
        budgetSeconds: input.budgetSeconds ?? ctx.config.defaultRunBudgetSeconds,
      });

      void ctx.pool.submit(async () => {
        await executeRun(
          { config: ctx.config, db: ctx.db, events: ctx.events, runs: ctx.runs },
          runId,
        );
      });

      return { runId };
    }),

  abort: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const ok = ctx.runs.abort(input.id);
    return { ok };
  }),

  events: protectedProcedure
    .input(
      z.object({
        runId: z.string(),
        since: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const sinceFilter = input.since
        ? and(eq(schema.events.runId, input.runId), gt(schema.events.id, input.since))
        : eq(schema.events.runId, input.runId);
      return ctx.db
        .select()
        .from(schema.events)
        .where(sinceFilter)
        .orderBy(asc(schema.events.id))
        .limit(2000)
        .all();
    }),
});
