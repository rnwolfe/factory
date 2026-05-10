import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { cancelDeferredTask, DeferredTaskNotFoundError } from "../deferred-tasks/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

// Match the intervention/session log-tail policy: a multi-megabyte build
// log shouldn't ship in full on every reconnect.
const MAX_DEFERRED_TAIL_BYTES = 128 * 1024;

export const deferredTasksRouter = router({
  /**
   * Lookup the deferred task attached to a run. Most run rows have at
   * most one — the agent emits `factory-defer` once per turn — but if
   * a continuation run is itself deferred we return the latest by start
   * time.
   */
  forRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.runId, input.runId))
        .orderBy(desc(schema.deferredTasks.startedAt))
        .all();
      return rows[0] ?? null;
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const row = await ctx.db
      .select()
      .from(schema.deferredTasks)
      .where(eq(schema.deferredTasks.id, input.id))
      .get();
    return row ?? null;
  }),

  /**
   * Project-scoped listing for the project detail screen's deferred-task
   * dock. Bounded — the operator deals with a handful of in-flight tasks
   * at a time, not history mining.
   */
  listForProject: protectedProcedure
    .input(
      z.object({ projectId: z.string(), limit: z.number().int().positive().max(100).optional() }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.projectId, input.projectId))
        .orderBy(desc(schema.deferredTasks.startedAt))
        .limit(input.limit ?? 25)
        .all();
      return rows;
    }),

  /**
   * SIGTERM the subprocess and mark the row cancelled. The
   * `proc.exited` future inside the orchestrator eventually resolves
   * with whatever the kernel reports; `onDeferredCompletion` sees the
   * `cancelled` status and skips the continuation submit.
   *
   * Idempotent: cancelling an already-terminal task is a no-op that
   * returns `cancelled: false, alreadyTerminal: <status>`.
   */
  cancel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await cancelDeferredTask(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          input.id,
        );
      } catch (err) {
        if (err instanceof DeferredTaskNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /**
   * Read the tail of the deferred command's combined stdout/stderr log.
   * Mirrors `interventions.tail` — same byte cap, same offset/size
   * semantics for incremental polling.
   */
  tail: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const row = await ctx.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, input.id))
        .get();
      if (!row) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }
      if (!existsSync(row.logPath)) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }
      const size = statSync(row.logPath).size;
      const start = input.offset ?? Math.max(0, size - MAX_DEFERRED_TAIL_BYTES);
      const length = Math.min(MAX_DEFERRED_TAIL_BYTES, Math.max(0, size - start));
      if (length === 0) {
        return { content: "", offset: size, size, truncated: false };
      }
      const fh = await open(row.logPath, "r");
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
