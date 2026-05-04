import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { bootstrapFromPlan } from "../plans/bootstrap-from-plan.ts";
import {
  parseStoredDraft,
  runPlanIteration,
  seedProjectSpecDraft,
  seedRefinementDraft,
  seedTaskPlanDraft,
} from "../plans/iterate.ts";
import { applyRefinementFreeze } from "../plans/refine.ts";
import { readTaskFile } from "../projects/tasks.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const plansRouter = router({
  inbox: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.status, "drafting"))
      .orderBy(desc(schema.plans.createdAt))
      .all();
  }),

  list: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where = input?.projectId ? eq(schema.plans.projectId, input.projectId) : undefined;
      const q = ctx.db.select().from(schema.plans);
      const rows = await (where ? q.where(where) : q).orderBy(desc(schema.plans.createdAt)).all();
      return rows;
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(schema.plans).where(eq(schema.plans.id, input.id)).get() ?? null;
  }),

  comments: protectedProcedure
    .input(z.object({ planId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.planComments)
        .where(eq(schema.planComments.planId, input.planId))
        .orderBy(asc(schema.planComments.createdAt))
        .all();
    }),

  startProjectFoundry: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.kind !== "triage") {
        throw new Error("foundry plans only spawn from triage decisions");
      }

      // Reuse an existing drafting project_spec plan rather than stacking
      // duplicates if the operator approves the same triage decision twice.
      const existing = await ctx.db
        .select()
        .from(schema.plans)
        .where(and(eq(schema.plans.decisionId, decision.id), eq(schema.plans.kind, "project_spec")))
        .get();
      if (existing) return { planId: existing.id };

      const payload = decision.payload as TriageDecisionPayload;
      const seed = seedProjectSpecDraft(payload);
      const planId = createId();
      const now = Date.now();
      const goal =
        payload.title_suggestion ??
        payload.spec_stub?.summary?.slice(0, 120) ??
        "Refine project spec";
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId: decision.id,
        goal,
        draft: JSON.stringify(seed),
        createdAt: now,
        updatedAt: now,
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "project_spec",
      });

      return { planId };
    }),

  startTaskPlan: protectedProcedure
    .input(z.object({ projectId: z.string(), taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");

      // Surface a duplicate-drafting-plan as the existing one, not a new row.
      const existing = await ctx.db
        .select()
        .from(schema.plans)
        .where(
          and(
            eq(schema.plans.projectId, input.projectId),
            eq(schema.plans.taskId, input.taskId),
            eq(schema.plans.kind, "task_plan"),
            eq(schema.plans.status, "drafting"),
          ),
        )
        .get();
      if (existing) return { planId: existing.id };

      const task = await readTaskFile(project.workdirPath, input.taskId);
      if (!task) throw new Error(`task ${input.taskId} not found in project`);

      const seed = seedTaskPlanDraft();
      const planId = createId();
      const now = Date.now();
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "task_plan",
        status: "drafting",
        projectId: project.id,
        taskId: input.taskId,
        goal: task.frontmatter.title,
        draft: JSON.stringify(seed),
        createdAt: now,
        updatedAt: now,
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "task_plan",
        projectId: project.id,
      });

      // Kick off the agent's first turn immediately — empty draft + empty
      // thread becomes the agent's seed-from-task pass. Same fire-and-forget
      // shape as decisions.comment.
      void (async () => {
        try {
          const result = await runPlanIteration(ctx.db, planId);
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_comment_added",
            planId,
            role: "agent",
          });
          if (result.draftUpdated) {
            ctx.events.publish({ channel: "inbox", kind: "plan_updated", planId });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[plan-iterate] ${planId}: ${message}`);
          await ctx.db.insert(schema.planComments).values({
            id: createId(),
            planId,
            role: "agent",
            body: `(plan iteration failed: ${message.slice(0, 240)})`,
            createdAt: Date.now(),
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_comment_added",
            planId,
            role: "agent",
          });
        }
      })();

      return { planId };
    }),

  startRefinement: protectedProcedure
    .input(z.object({ projectId: z.string(), taskId: z.string(), runId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");

      const existing = await ctx.db
        .select()
        .from(schema.plans)
        .where(
          and(
            eq(schema.plans.projectId, input.projectId),
            eq(schema.plans.taskId, input.taskId),
            eq(schema.plans.kind, "refinement"),
            eq(schema.plans.status, "drafting"),
          ),
        )
        .get();
      if (existing) return { planId: existing.id };

      const task = await readTaskFile(project.workdirPath, input.taskId);
      if (!task) throw new Error(`task ${input.taskId} not found in project`);

      const seed = seedRefinementDraft(input.taskId);
      const planId = createId();
      const now = Date.now();
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "refinement",
        status: "drafting",
        projectId: project.id,
        taskId: input.taskId,
        goal: `Refine: ${task.frontmatter.title}`,
        draft: JSON.stringify(seed),
        createdAt: now,
        updatedAt: now,
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "refinement",
        projectId: project.id,
      });

      return { planId };
    }),

  comment: protectedProcedure
    .input(
      z.object({
        planId: z.string(),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, input.planId))
        .get();
      if (!plan) throw new Error("plan not found");
      if (plan.status !== "drafting") {
        throw new Error(`plan already ${plan.status} — cannot add comments`);
      }

      const commentId = createId();
      await ctx.db.insert(schema.planComments).values({
        id: commentId,
        planId: input.planId,
        role: "operator",
        body: input.body.trim(),
        createdAt: Date.now(),
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_comment_added",
        planId: input.planId,
        role: "operator",
      });

      // Background agent iteration. Same fire-and-forget shape as triage
      // follow-up — the UI shows the operator's message instantly while the
      // agent's reply lands asynchronously.
      void (async () => {
        try {
          const result = await runPlanIteration(ctx.db, input.planId);
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_comment_added",
            planId: input.planId,
            role: "agent",
          });
          if (result.draftUpdated) {
            ctx.events.publish({
              channel: "inbox",
              kind: "plan_updated",
              planId: input.planId,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[plan-iterate] ${input.planId}: ${message}`);
          await ctx.db.insert(schema.planComments).values({
            id: createId(),
            planId: input.planId,
            role: "agent",
            body: `(plan iteration failed: ${message.slice(0, 240)})`,
            createdAt: Date.now(),
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_comment_added",
            planId: input.planId,
            role: "agent",
          });
        }
      })();

      return { commentId };
    }),

  freeze: protectedProcedure
    .input(z.object({ planId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, input.planId))
        .get();
      if (!plan) throw new Error("plan not found");
      if (plan.status !== "drafting") {
        throw new Error(`plan already ${plan.status}`);
      }

      const now = Date.now();
      await ctx.db
        .update(schema.plans)
        .set({ status: "frozen", frozenAt: now, updatedAt: now })
        .where(eq(schema.plans.id, input.planId));

      let projectId: string | null = plan.projectId ?? null;
      const taskId: string | null = plan.taskId ?? null;

      if (plan.kind === "project_spec") {
        // Bootstrap the project from the frozen draft. The plan's draft has
        // priority over the original spec_stub.
        const result = await bootstrapFromPlan(ctx.config, ctx.db, input.planId);
        projectId = result.projectId;
        await ctx.db
          .update(schema.plans)
          .set({ projectId })
          .where(eq(schema.plans.id, input.planId));
      } else if (plan.kind === "refinement") {
        // Apply the refinement: rewrite acceptance + emit followups (as new
        // task files committed on main).
        if (!plan.projectId || !plan.taskId) {
          throw new Error("refinement plan missing projectId/taskId at freeze time");
        }
        await applyRefinementFreeze({
          config: ctx.config,
          db: ctx.db,
          projectId: plan.projectId,
          taskId: plan.taskId,
          draft: parseStoredDraft(plan.draft),
        });
      }
      // task_plan: no immediate side-effect; the next run.submit on this
      // task will pick up the plan via task_plan_id.

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_frozen",
        planId: input.planId,
        projectId,
        taskId,
      });

      return { ok: true, projectId, taskId };
    }),

  abandon: protectedProcedure
    .input(z.object({ planId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, input.planId))
        .get();
      if (!plan) throw new Error("plan not found");
      if (plan.status !== "drafting") {
        throw new Error(`plan already ${plan.status}`);
      }
      const now = Date.now();
      await ctx.db
        .update(schema.plans)
        .set({ status: "abandoned", abandonedAt: now, updatedAt: now })
        .where(eq(schema.plans.id, input.planId));

      ctx.events.publish({ channel: "inbox", kind: "plan_abandoned", planId: input.planId });
      return { ok: true };
    }),
});
