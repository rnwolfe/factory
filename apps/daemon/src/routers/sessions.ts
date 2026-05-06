import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { abortSession, endSession, SessionError, startSession } from "../sessions/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

const ModeEnum = z.enum(["claude", "shell"]);

function mapError(err: unknown): TRPCError {
  if (err instanceof SessionError) {
    if (err.code === "session_not_found" || err.code === "project_not_found") {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err.code === "concurrent_session" || err.code === "session_not_running") {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : String(err),
  });
}

export const sessionsRouter = router({
  start: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        mode: ModeEnum.optional(),
        description: z.string().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await startSession(ctx.config, ctx.db, ctx.events, {
          projectId: input.projectId,
          mode: input.mode,
          description: input.description ?? null,
        });
      } catch (err) {
        throw mapError(err);
      }
    }),

  end: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      return await endSession(ctx.config, ctx.db, ctx.events, input.id);
    } catch (err) {
      throw mapError(err);
    }
  }),

  abort: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      await abortSession(ctx.config, ctx.db, ctx.events, input.id);
      return { ok: true };
    } catch (err) {
      throw mapError(err);
    }
  }),

  list: protectedProcedure
    .input(z.object({ projectId: z.string(), limit: z.number().int().min(1).max(100).optional() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.projectId, input.projectId))
        .orderBy(desc(schema.sessions.startedAt))
        .limit(input.limit ?? 20)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const row = await ctx.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, input.id))
      .get();
    return row ?? null;
  }),
});
