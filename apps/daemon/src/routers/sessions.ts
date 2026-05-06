import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { abortSession, endSession, SessionError, startSession } from "../sessions/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

const ModeEnum = z.enum(["claude", "shell"]);

// Cap per-request tail read so a long-running session doesn't ship a
// multi-megabyte log on every reconnect. 128 KiB ≈ a few thousand lines
// of typical shell output — plenty for "what was I doing?" recovery.
const MAX_SESSION_TAIL_BYTES = 128 * 1024;

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

  /**
   * Read the tail of the session's tmux pipe-pane log. Used by the
   * session pane on mount + on reconnect so revisiting a session
   * shows the prior scrollback before live bytes arrive.
   *
   * The log is the same file pipe-pane writes to:
   *   <worktreesRoot>/<slug>/_session-logs/<sessionId>.log
   * It survives daemon restarts and the PWA reload, so closing and
   * reopening the page reconstitutes the terminal view.
   */
  tail: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const session = await ctx.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, input.id))
        .get();
      if (!session) return { content: "", offset: 0, size: 0, truncated: false };
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, session.projectId))
        .get();
      if (!project) return { content: "", offset: 0, size: 0, truncated: false };

      const logPath = path.join(
        ctx.config.worktreesRoot,
        project.slug,
        "_session-logs",
        `${session.id}.log`,
      );
      if (!existsSync(logPath)) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }
      const size = statSync(logPath).size;
      const start = input.offset ?? Math.max(0, size - MAX_SESSION_TAIL_BYTES);
      const length = Math.min(MAX_SESSION_TAIL_BYTES, Math.max(0, size - start));
      if (length === 0) {
        return { content: "", offset: size, size, truncated: false };
      }
      const fh = await open(logPath, "r");
      try {
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, start);
        return {
          content: buf.toString("utf8"),
          offset: start + length,
          size,
          truncated: start > 0,
        };
      } finally {
        await fh.close();
      }
    }),
});
