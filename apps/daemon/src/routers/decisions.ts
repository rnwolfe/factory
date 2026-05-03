import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { bootstrapProject } from "../projects/bootstrap.ts";
import { runFollowupTriage, type TriageDecisionPayload } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

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

      if (input.action === "approve" && decision.kind === "triage") {
        if (!decision.ideaId) throw new Error("triage decision missing ideaId");
        const idea = await ctx.db
          .select()
          .from(schema.ideas)
          .where(eq(schema.ideas.id, decision.ideaId))
          .get();
        if (!idea) throw new Error("idea not found for decision");

        const payload = decision.payload as TriageDecisionPayload;
        const goal = (idea.goalHint ?? "me") as "me" | "learn" | "share" | "productize";
        const result = await bootstrapProject(ctx.config, ctx.db, {
          ideaId: idea.id,
          decisionId: decision.id,
          payload,
          ideaText: idea.rawText,
          goal,
          tier: "tinker",
          model: input.model ?? null,
        });
        projectId = result.projectId;
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

      return { ok: true, projectId };
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
