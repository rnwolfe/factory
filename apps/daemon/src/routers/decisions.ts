import { schema } from "@factory/db";
import { mergeIntoMain } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { seedProjectSpecDraft } from "../plans/iterate.ts";
import { runFollowupTriage, type TriageDecisionPayload } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { submitRun } from "../workers/submit.ts";

interface BlockedRunPayload {
  runId: string;
  taskId?: string | null;
  summary?: string;
  questions?: string[];
  branch?: string;
}

interface MergeFailurePayload {
  runId: string;
  taskId?: string | null;
  branch: string;
  reason: string;
  message: string;
  summary?: string;
}

const ActionEnum = z.enum(["approve", "park", "trash", "decompose", "dismiss"]);

export const decisionsRouter = router({
  inbox: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.status, "pending"))
      .orderBy(desc(schema.decisions.createdAt))
      .all();
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(50) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.decisions)
        .where(ne(schema.decisions.status, "pending"))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(input.limit)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return (
      ctx.db.select().from(schema.decisions).where(eq(schema.decisions.id, input.id)).get() ?? null
    );
  }),

  action: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        action: ActionEnum,
        note: z.string().optional(),
        /** Claude model id for the project's runs. Approve-only; ignored otherwise. */
        model: z.string().nullable().optional(),
        /** Ceremony level carried into the project_spec plan and on into bootstrap. */
        ceremony: z.enum(["tinker", "personal", "shared", "production"]).optional(),
        /** Owner vs contributor — determines whether bootstrap creates a vision plan. */
        role: z.enum(["owner", "contributor"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.status !== "pending") {
        throw new Error(`decision already ${decision.status}`);
      }

      let projectId: string | null = null;
      let retryRunId: string | null = null;
      let mergedSha: string | null = null;
      let planId: string | null = null;

      if (input.action === "approve" && decision.kind === "merge_failure") {
        // Retry the merge of the run's branch into main. If main is still
        // dirty (the original failure mode) the operator gets a clear error
        // and the decision stays pending — they can clean up and approve
        // again. Success closes the decision.
        const payload = decision.payload as MergeFailurePayload;
        if (!decision.projectId) throw new Error("merge_failure decision missing projectId");
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, decision.projectId))
          .get();
        if (!project) throw new Error("project not found");
        const taskLabel = payload.taskId ?? "ad-hoc";
        const merge = await mergeIntoMain({
          projectPath: project.workdirPath,
          branch: payload.branch,
          message: `factory: merge ${taskLabel} · run ${payload.runId.slice(0, 8)} (retry)`,
          author: ctx.config.gitAuthor,
        });
        if (!merge.ok) {
          throw new Error(`merge still failing — ${merge.reason}: ${merge.message}`);
        }
        mergedSha = merge.sha;
        projectId = project.id;
        if (!merge.alreadyMerged) {
          ctx.events.publish({
            channel: "events",
            kind: "commit",
            runId: payload.runId,
            iteration: 1,
            sha: merge.sha,
            subject: `merge to main: ${payload.branch}`,
          });
        }
      }

      if (input.action === "approve" && decision.kind === "blocked_run") {
        // "approve" on a blocked-run decision means retry. Submit a new run
        // whose worktree is based on the source run's branch tip — partial
        // work and the source run's auto-commit ride forward.
        const payload = decision.payload as BlockedRunPayload;
        const source = await ctx.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, payload.runId))
          .get();
        if (!source) throw new Error("source run not found");
        const result = await submitRun(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          {
            projectId: source.projectId,
            taskId: source.taskId ?? undefined,
            baseRef: source.branch,
          },
        );
        retryRunId = result.runId;
        projectId = source.projectId;
      }

      if (input.action === "approve" && decision.kind === "triage") {
        if (!decision.ideaId) throw new Error("triage decision missing ideaId");

        // v0.2: route triage approval through a project_spec foundry plan
        // instead of bootstrapping immediately. The decision is marked
        // actioned (the approval happened); the project materializes when
        // the operator freezes the plan.
        const existing = await ctx.db
          .select()
          .from(schema.plans)
          .where(
            and(eq(schema.plans.decisionId, decision.id), eq(schema.plans.kind, "project_spec")),
          )
          .get();
        if (existing) {
          planId = existing.id;
        } else {
          const payload = decision.payload as TriageDecisionPayload;
          const seed = seedProjectSpecDraft(payload);
          const id = createId();
          const tnow = Date.now();
          const goalText =
            payload.title_suggestion ??
            payload.spec_stub?.summary?.slice(0, 120) ??
            "Refine project spec";
          await ctx.db.insert(schema.plans).values({
            id,
            kind: "project_spec",
            status: "drafting",
            decisionId: decision.id,
            goal: goalText,
            draft: JSON.stringify(seed),
            ceremony: input.ceremony ?? null,
            createdAt: tnow,
            updatedAt: tnow,
          });
          planId = id;
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_created",
            planId: id,
            planKind: "project_spec",
          });
        }
      }

      const now = Date.now();
      await ctx.db
        .update(schema.decisions)
        .set({
          status: input.action === "dismiss" ? "dismissed" : "actioned",
          actionedAt: now,
          ...(projectId ? { projectId } : {}),
        })
        .where(eq(schema.decisions.id, input.decisionId));

      ctx.events.publish({
        channel: "inbox",
        kind: "decision_actioned",
        decisionId: input.decisionId,
      });

      return { ok: true, projectId, retryRunId, mergedSha, planId };
    }),

  comments: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.decisionComments)
        .where(eq(schema.decisionComments.decisionId, input.decisionId))
        .orderBy(asc(schema.decisionComments.createdAt))
        .all();
    }),

  comment: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.status !== "pending") {
        throw new Error(`decision already ${decision.status} — cannot add comments`);
      }
      if (decision.kind !== "triage") {
        throw new Error("comments are only supported on triage decisions");
      }

      const commentId = createId();
      await ctx.db.insert(schema.decisionComments).values({
        id: commentId,
        decisionId: input.decisionId,
        role: "operator",
        body: input.body.trim(),
        createdAt: Date.now(),
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "comment_added",
        decisionId: input.decisionId,
        role: "operator",
      });

      // Fire the follow-up triage in the background — the mutation returns
      // immediately so the UI shows the operator's message instantly. The
      // agent's reply is broadcast over /ws/inbox when it lands.
      void (async () => {
        try {
          await runFollowupTriage(ctx.db, input.decisionId);
          ctx.events.publish({
            channel: "inbox",
            kind: "comment_added",
            decisionId: input.decisionId,
            role: "agent",
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "decision_updated",
            decisionId: input.decisionId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[triage-followup] ${input.decisionId}: ${message}`);
          // Surface the error in the thread so the operator isn't left waiting
          // on a silent failure.
          await ctx.db.insert(schema.decisionComments).values({
            id: createId(),
            decisionId: input.decisionId,
            role: "agent",
            body: `(follow-up triage failed: ${message.slice(0, 240)})`,
            createdAt: Date.now(),
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "comment_added",
            decisionId: input.decisionId,
            role: "agent",
          });
        }
      })();

      return { commentId };
    }),
});
