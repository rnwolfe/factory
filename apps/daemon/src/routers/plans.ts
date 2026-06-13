import type { FeaturePlanDraft } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { applyFeaturePlanFreeze } from "../plans/apply-feature-plan.ts";
import { applyProjectVisionFreeze } from "../plans/apply-project-vision.ts";
import { applyTaskTemplateFreeze, seedTaskTemplateDraft } from "../plans/apply-task-template.ts";
import { bootstrapFromPlan } from "../plans/bootstrap-from-plan.ts";
import {
  parseStoredDraft,
  runPlanIteration,
  seedFeaturePlanDraft,
  seedProjectSpecDraft,
  seedProjectVisionDraft,
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

      const task = await readTaskFile(project, input.taskId);
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

  startFeaturePlan: protectedProcedure
    .input(z.object({ projectId: z.string(), goal: z.string().min(1).max(280) }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      const planId = createId();
      const now = Date.now();
      const seed = seedFeaturePlanDraft(input.goal);
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "feature_plan",
        status: "drafting",
        projectId: project.id,
        goal: input.goal,
        draft: JSON.stringify(seed),
        ceremony: project.ceremony ?? null,
        createdAt: now,
        updatedAt: now,
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "feature_plan",
        projectId: project.id,
      });

      // Kick off the agent's first turn — operator gets a draft to push back on.
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

  startProjectVision: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      // Reuse a drafting project_vision plan rather than stack duplicates.
      const existing = await ctx.db
        .select()
        .from(schema.plans)
        .where(
          and(
            eq(schema.plans.projectId, input.projectId),
            eq(schema.plans.kind, "project_vision"),
            eq(schema.plans.status, "drafting"),
          ),
        )
        .get();
      if (existing) return { planId: existing.id };

      const planId = createId();
      const now = Date.now();
      const seed = seedProjectVisionDraft();
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "project_vision",
        status: "drafting",
        projectId: project.id,
        goal: `Vision for ${project.name}`,
        draft: JSON.stringify(seed),
        ceremony: project.ceremony ?? null,
        createdAt: now,
        updatedAt: now,
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "project_vision",
        projectId: project.id,
      });

      // Kick off agent's first turn for the seed-from-context pass.
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

  /**
   * Start a task_template draft. Templates have no `projectId` — they live
   * outside any single project. Multiple drafts can coexist (in contrast
   * to vision/spec where we reuse a drafting plan) since each template
   * addresses a different operator-stated use case.
   */
  startTaskTemplate: protectedProcedure
    .input(
      z.object({
        /** Operator's stated intent — e.g. "add release-notes flow to a web project". */
        goal: z.string().min(4).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const planId = createId();
      const now = Date.now();
      const seed = seedTaskTemplateDraft();
      await ctx.db.insert(schema.plans).values({
        id: planId,
        kind: "task_template",
        status: "drafting",
        projectId: null,
        goal: input.goal,
        draft: JSON.stringify(seed),
        ceremony: null,
        createdAt: now,
        updatedAt: now,
      });
      ctx.events.publish({
        channel: "inbox",
        kind: "plan_created",
        planId,
        planKind: "task_template",
        projectId: null,
      });
      // Kick off the agent's first turn so the draft is already partly
      // filled when the operator opens the plan-detail page.
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
          await ctx.db.insert(schema.planComments).values({
            id: createId(),
            planId,
            role: "agent",
            body: `(initial iteration failed: ${err instanceof Error ? err.message : String(err)})`,
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

      const task = await readTaskFile(project, input.taskId);
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

      // Vision-filter precondition for feature_plan freezes — applies on
      // ceremony ≥ personal AND role=owner. Contributors work inside someone
      // else's vision, so the filter is skipped entirely for them.
      if (plan.kind === "feature_plan" && plan.projectId) {
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, plan.projectId))
          .get();
        const ceremony = plan.ceremony ?? project?.ceremony ?? "tinker";
        const role = project?.role ?? "owner";
        const filterApplies = role === "owner" && ceremony !== "tinker";
        if (filterApplies) {
          let parsed: FeaturePlanDraft | null = null;
          try {
            const obj = JSON.parse(plan.draft) as FeaturePlanDraft;
            if (obj.kind === "feature_plan") parsed = obj;
          } catch {
            // fall through — null parsed treated as failing the gate
          }
          const tests = parsed?.visionFilter ?? null;
          const failing: string[] = [];
          if (!tests?.identity?.passes) failing.push("identity");
          if (!tests?.principle?.passes) failing.push("principle");
          if (!tests?.phase?.passes) failing.push("phase");
          if (!tests?.replacement?.passes) failing.push("replacement");
          if (failing.length > 0) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `vision filter failing: ${failing.join(", ")} — iterate the plan until all four tests pass before freezing on a ${ceremony} project`,
            });
          }
        }
      }

      const now = Date.now();
      await ctx.db
        .update(schema.plans)
        .set({ status: "frozen", frozenAt: now, updatedAt: now })
        .where(eq(schema.plans.id, input.planId));

      let projectId: string | null = plan.projectId ?? null;
      const taskId: string | null = plan.taskId ?? null;

      // Apply per-kind side effects. project_spec → bootstrap; refinement →
      // rewrite acceptance + emit followups; feature_plan → emit tasks;
      // project_vision → write VISION.md; task_plan is no-op (next run.submit
      // picks it up).
      if (plan.kind === "project_spec") {
        const result = await bootstrapFromPlan(ctx.config, ctx.db, input.planId);
        projectId = result.projectId;
        await ctx.db
          .update(schema.plans)
          .set({ projectId })
          .where(eq(schema.plans.id, input.planId));

        // Auto-trigger a project_vision plan for ceremony ≥ personal AND
        // role=owner — operators contributing to someone else's project work
        // inside that project's existing vision and shouldn't author one.
        // Tinker projects skip this regardless of role; they get the spec,
        // not the ceremony.
        const ceremony = plan.ceremony ?? null;
        const projectRow = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get();
        const role = projectRow?.role ?? "owner";
        const visionApplies =
          role === "owner" &&
          (ceremony === "personal" || ceremony === "shared" || ceremony === "production");
        if (visionApplies) {
          const visionPlanId = createId();
          const vnow = Date.now();
          await ctx.db.insert(schema.plans).values({
            id: visionPlanId,
            kind: "project_vision",
            status: "drafting",
            projectId,
            goal: `Vision for ${plan.goal}`,
            draft: JSON.stringify(seedProjectVisionDraft()),
            ceremony,
            createdAt: vnow,
            updatedAt: vnow,
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_created",
            planId: visionPlanId,
            planKind: "project_vision",
            projectId,
          });
          // Fire-and-forget seed turn — same shape as startTaskPlan.
          void (async () => {
            try {
              const r = await runPlanIteration(ctx.db, visionPlanId);
              ctx.events.publish({
                channel: "inbox",
                kind: "plan_comment_added",
                planId: visionPlanId,
                role: "agent",
              });
              if (r.draftUpdated) {
                ctx.events.publish({
                  channel: "inbox",
                  kind: "plan_updated",
                  planId: visionPlanId,
                });
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`[plan-iterate] auto-vision ${visionPlanId}: ${message}`);
            }
          })();
        }
      } else if (plan.kind === "refinement") {
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
      } else if (plan.kind === "feature_plan") {
        if (!plan.projectId) {
          throw new Error("feature_plan missing projectId at freeze time");
        }
        const draft = parseStoredDraft(plan.draft);
        if (draft.kind !== "feature_plan") {
          throw new Error(`feature_plan ${plan.id} draft kind mismatch: ${draft.kind}`);
        }
        await applyFeaturePlanFreeze({
          config: ctx.config,
          db: ctx.db,
          projectId: plan.projectId,
          draft,
          planId: plan.id,
        });
      } else if (plan.kind === "project_vision") {
        if (!plan.projectId) {
          throw new Error("project_vision missing projectId at freeze time");
        }
        const draft = parseStoredDraft(plan.draft);
        if (draft.kind !== "project_vision") {
          throw new Error(`project_vision ${plan.id} draft kind mismatch: ${draft.kind}`);
        }
        await applyProjectVisionFreeze({
          config: ctx.config,
          db: ctx.db,
          projectId: plan.projectId,
          draft,
          planId: plan.id,
        });
      } else if (plan.kind === "task_template") {
        // Task templates are Factory-canonical, not per-project. There's
        // no projectId precondition — the frozen draft lands in the
        // task_templates table where the picker on any project page can
        // see it.
        const draft = parseStoredDraft(plan.draft);
        if (draft.kind !== "task_template") {
          throw new Error(`task_template ${plan.id} draft kind mismatch: ${draft.kind}`);
        }
        await applyTaskTemplateFreeze({
          db: ctx.db,
          draft,
          planId: plan.id,
          now,
        });
      }

      // v0.3 — when a newer plan in the same kind+target supersedes a prior
      // frozen plan, transition the prior plan to status='superseded' and
      // record the supersededBy pointer. Same kind+target tuple is:
      //   - project_spec/feature_plan/project_vision: kind + projectId
      //   - task_plan/refinement: kind + projectId + taskId
      // The triage-rooted project_spec plan has projectId set on freeze (we
      // just stamped it for that path), so the lookup below sees the new id.
      const supersedeMatchers = [
        eq(schema.plans.kind, plan.kind),
        eq(schema.plans.status, "frozen"),
      ];
      if (plan.kind === "task_plan" || plan.kind === "refinement") {
        if (plan.projectId) supersedeMatchers.push(eq(schema.plans.projectId, plan.projectId));
        if (plan.taskId) supersedeMatchers.push(eq(schema.plans.taskId, plan.taskId));
      } else {
        if (plan.projectId) supersedeMatchers.push(eq(schema.plans.projectId, plan.projectId));
      }
      const priorFrozen = await ctx.db
        .select()
        .from(schema.plans)
        .where(and(...supersedeMatchers))
        .all();
      for (const p of priorFrozen) {
        if (p.id === plan.id) continue;
        await ctx.db
          .update(schema.plans)
          .set({ status: "superseded", supersededBy: plan.id, updatedAt: now })
          .where(eq(schema.plans.id, p.id));
        ctx.events.publish({
          channel: "inbox",
          kind: "plan_superseded",
          planId: p.id,
          supersededBy: plan.id,
        });
      }

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
