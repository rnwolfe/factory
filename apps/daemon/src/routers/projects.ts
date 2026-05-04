import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  createTask,
  listTasks,
  readTaskFile,
  renderAcceptanceBlock,
  updateTaskBody,
  updateTaskStatus,
} from "../projects/tasks.ts";
import { snapshotWorkdir } from "../projects/workdir.ts";
import { protectedProcedure, router } from "../trpc.ts";

const TagEnum = z.enum(["active", "background", "past"]);
const TierEnum = z.enum(["tinker", "personal", "share", "productize"]);
const TaskStatusEnum = z.enum(["ready", "in_progress", "review", "done", "blocked", "dropped"]);
const TaskEstimateEnum = z.enum(["small", "medium", "large"]);
const TaskPriorityEnum = z.enum(["low", "med", "high"]);

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
  get: protectedProcedure
    .input(z.object({ projectId: z.string(), taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return null;
      const task = await readTaskFile(project.workdirPath, input.taskId);
      if (!task) return null;
      return { frontmatter: task.frontmatter, body: task.body };
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
      // Commit on main so the next run's worktree starts clean. Without this,
      // operator-driven status flips dirty the project tree and the next
      // mergeIntoMain refuses ("project working tree has uncommitted changes").
      await commitAllChanges(
        project.workdirPath,
        `chore: ${input.taskId} status -> ${input.status}`,
        ctx.config.gitAuthor,
      );
      return updated.frontmatter;
    }),
  updateBody: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        body: z.string().max(50_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskBody(project.workdirPath, input.taskId, input.body);
      if (!updated) throw new Error("task not found");
      await commitAllChanges(
        project.workdirPath,
        `docs: ${input.taskId} body update`,
        ctx.config.gitAuthor,
      );
      return { frontmatter: updated.frontmatter, body: updated.body };
    }),
  /**
   * Create a task directly (no plan freeze required). Used by audit-finding
   * promotion (bug path), the PWA "+ task" button, and any other ad-hoc
   * capture path. Routes through tasks.createTask so the storage seam stays
   * single-pointed.
   */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
        parent: z.string().max(40).optional(),
        estimate: TaskEstimateEnum.optional(),
        priority: TaskPriorityEnum.optional(),
        acceptance: z.array(z.string().max(500)).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const body =
        input.body ??
        `## Acceptance\n\n${renderAcceptanceBlock(input.acceptance)}\n\n## Notes\n\n(operator-captured)\n`;
      const created = await createTask(project.workdirPath, {
        title: input.title,
        body,
        labels: input.labels,
        parent: input.parent,
        estimate: input.estimate,
        priority: input.priority,
      });
      await commitAllChanges(
        project.workdirPath,
        `chore: capture ${created.id} — ${input.title.slice(0, 60)}`,
        ctx.config.gitAuthor,
      );
      // Touch project lastActivityAt so the dashboard reflects the capture.
      await ctx.db
        .update(schema.projects)
        .set({ lastActivityAt: Date.now() })
        .where(eq(schema.projects.id, project.id));
      return { task: { frontmatter: created.frontmatter, body: created.body } };
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

  setTier: protectedProcedure
    .input(z.object({ id: z.string(), tier: TierEnum }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ tier: input.tier })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, tier: input.tier };
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
