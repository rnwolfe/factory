import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appendOperatorComment, listFeedbackComments, runAgentReply } from "../feedback/iterate.ts";
import { PromoteError, promoteToPlan, promoteToTask } from "../feedback/promote.ts";
import {
  appendFeedback,
  getFeedback,
  listOpenFeedback,
  setFeedbackSnooze,
  setFeedbackStatus,
} from "../feedback/store.ts";
import { inboxViewInput, snoozeInput } from "../inbox-snooze.ts";
import { protectedProcedure, router } from "../trpc.ts";

const VoteEnum = z.enum(["up", "down"]);

export const feedbackRouter = router({
  submit: protectedProcedure
    .input(
      z.object({
        vote: VoteEnum,
        body: z.string().min(1).max(1000),
        contextRoute: z.string().max(500).optional(),
        contextHint: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = appendFeedback(ctx.db, input);
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "insert lost" });
      ctx.events.publish({
        channel: "inbox",
        kind: "feedback_created",
        feedbackId: row.id,
      });

      // Fire-and-forget initial agent triage. Same pattern as ideas.create —
      // the mutation returns immediately; the agent's comment row appears later
      // via the inbox WS event. Idempotency: only fires while status is still
      // "open" — if the item is somehow already resolved/dismissed this is a no-op.
      const feedbackId = row.id;
      void (async () => {
        const cur = getFeedback(ctx.db, feedbackId);
        if (!cur || cur.status !== "open") return;
        await runAgentReply(ctx.db, feedbackId);
        ctx.events.publish({
          channel: "inbox",
          kind: "feedback_comment_added",
          feedbackId,
          role: "agent",
        });
        // Transition open → in_progress to reflect that engagement has started.
        const after = getFeedback(ctx.db, feedbackId);
        if (after?.status === "open") {
          setFeedbackStatus(ctx.db, feedbackId, "in_progress");
          ctx.events.publish({ channel: "inbox", kind: "feedback_updated", feedbackId });
        }
      })();

      return row;
    }),

  inbox: protectedProcedure.input(inboxViewInput).query(async ({ ctx, input }) => {
    return listOpenFeedback(ctx.db, input.view);
  }),

  snooze: protectedProcedure.input(snoozeInput).mutation(async ({ ctx, input }) => {
    const row = setFeedbackSnooze(ctx.db, input.id, input.snoozedUntil);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "feedback not found" });
    if (row.status !== "open" && row.status !== "in_progress") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "feedback is not open" });
    }
    ctx.events.publish({
      channel: "inbox",
      kind: "feedback_updated",
      feedbackId: row.id,
    });
    return row;
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return getFeedback(ctx.db, input.id);
  }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = setFeedbackStatus(ctx.db, input.id, "dismissed");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "feedback not found" });
      ctx.events.publish({
        channel: "inbox",
        kind: "feedback_updated",
        feedbackId: row.id,
      });
      return row;
    }),

  resolve: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        resolvedTarget: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = setFeedbackStatus(ctx.db, input.id, "resolved", {
        resolvedTarget: input.resolvedTarget ?? null,
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "feedback not found" });
      ctx.events.publish({
        channel: "inbox",
        kind: "feedback_updated",
        feedbackId: row.id,
      });
      return row;
    }),

  comments: protectedProcedure
    .input(z.object({ feedbackId: z.string() }))
    .query(async ({ ctx, input }) => {
      return listFeedbackComments(ctx.db, input.feedbackId);
    }),

  comment: protectedProcedure
    .input(
      z.object({
        feedbackId: z.string(),
        body: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const operator = await appendOperatorComment(ctx.db, input.feedbackId, input.body);
      // Move from open → in_progress on first operator engagement.
      const fb = getFeedback(ctx.db, input.feedbackId);
      if (fb?.status === "open") {
        setFeedbackStatus(ctx.db, fb.id, "in_progress");
      }
      ctx.events.publish({
        channel: "inbox",
        kind: "feedback_comment_added",
        feedbackId: operator.feedbackId,
        role: "operator",
      });
      // Fire the agent reply asynchronously — the mutation returns as soon
      // as the operator's row is persisted; the agent's row appears later
      // via the inbox WS event. Skip if the item has already been routed
      // (resolved/dismissed) to prevent re-triaging closed items.
      if (fb?.status === "resolved" || fb?.status === "dismissed") return operator;
      runAgentReply(ctx.db, input.feedbackId)
        .then((res) => {
          ctx.events.publish({
            channel: "inbox",
            kind: "feedback_comment_added",
            feedbackId: input.feedbackId,
            role: "agent",
          });
          if (res.errorMessage) {
            // Already persisted as an agent-role row in iterate.ts; nothing more to do.
          }
        })
        .catch(() => {
          // never escape — iterate.ts already persists a placeholder row
        });
      return operator;
    }),

  promoteToPlan: protectedProcedure
    .input(z.object({ feedbackId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await promoteToPlan({
          config: ctx.config,
          db: ctx.db,
          feedbackId: input.feedbackId,
        });
        ctx.events.publish({
          channel: "inbox",
          kind: "feedback_updated",
          feedbackId: input.feedbackId,
        });
        return result;
      } catch (err) {
        if (err instanceof PromoteError) {
          const code =
            err.code === "no_factory_project" || err.code === "project_not_found"
              ? "PRECONDITION_FAILED"
              : "NOT_FOUND";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),

  promoteToTask: protectedProcedure
    .input(z.object({ feedbackId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await promoteToTask({
          config: ctx.config,
          db: ctx.db,
          feedbackId: input.feedbackId,
        });
        ctx.events.publish({
          channel: "inbox",
          kind: "feedback_updated",
          feedbackId: input.feedbackId,
        });
        return result;
      } catch (err) {
        if (err instanceof PromoteError) {
          const code =
            err.code === "no_factory_project" || err.code === "project_not_found"
              ? "PRECONDITION_FAILED"
              : "NOT_FOUND";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),

  config: protectedProcedure.query(async ({ ctx }) => {
    return {
      factoryProjectId: ctx.config.factoryProjectId,
    };
  }),
});
