import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { listTasks, updateTaskStatus } from "../projects/tasks.ts";
import { snapshotWorkdir } from "../projects/workdir.ts";
import { protectedProcedure, router } from "../trpc.ts";

const TagEnum = z.enum(["active", "background", "past"]);
const TaskStatusEnum = z.enum(["ready", "in_progress", "review", "done", "blocked", "dropped"]);

const tasksRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return [];
      const tasks = await listTasks(project.workdirPath);
      return tasks.map((t) => t.frontmatter);
    }),
  updateStatus: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        status: TaskStatusEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskStatus(project.workdirPath, input.taskId, input.status);
      if (!updated) throw new Error("task not found");
      return updated.frontmatter;
    }),
});

export const projectsRouter = router({
  list: protectedProcedure
    .input(z.object({ tag: TagEnum.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where = input?.tag ? eq(schema.projects.tag, input.tag) : undefined;
      const q = ctx.db.select().from(schema.projects);
      const rows = await (where ? q.where(where) : q)
        .orderBy(desc(schema.projects.lastActivityAt))
        .all();
      return rows;
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const project = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, input.id))
      .get();
    if (!project) return null;
    const tasks = await listTasks(project.workdirPath);
    return { project, tasks: tasks.map((t) => t.frontmatter) };
  }),

  tag: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        tag: TagEnum,
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.id))
        .get();
      if (!project) throw new Error("project not found");

      const now = Date.now();
      await ctx.db
        .update(schema.projects)
        .set({ tag: input.tag, lastActivityAt: now })
        .where(eq(schema.projects.id, input.id));

      // Log a tag_change decision in actioned state — provides an audit trail
      // and surfaces in history.
      const decisionId = createId();
      await ctx.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "tag_change",
        projectId: project.id,
        outcome: `tag:${input.tag}`,
        payload: { previousTag: project.tag, newTag: input.tag, note: input.note ?? null },
        status: "actioned",
        createdAt: now,
        actionedAt: now,
      });

      return { ok: true, tag: input.tag };
    }),

  setAutoAdvance: protectedProcedure
    .input(z.object({ id: z.string(), autoAdvance: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ autoAdvance: input.autoAdvance })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, autoAdvance: input.autoAdvance };
    }),

  setModel: protectedProcedure
    .input(z.object({ id: z.string(), model: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ model: input.model })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, model: input.model };
    }),

  workdir: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const project = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, input.id))
      .get();
    if (!project) return null;
    return snapshotWorkdir(project.workdirPath);
  }),

  tasks: tasksRouter,
});
