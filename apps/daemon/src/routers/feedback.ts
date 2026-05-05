import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  appendFeedback,
  getFeedback,
  listOpenFeedback,
  setFeedbackStatus,
} from "../feedback/store.ts";
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
      return row;
    }),

  inbox: protectedProcedure.query(async ({ ctx }) => {
    return listOpenFeedback(ctx.db);
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
});
