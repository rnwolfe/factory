import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  cancelIntervention,
  InterventionError,
  resumeFromIntervention,
  startIntervention,
} from "../interventions/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

// Cap per-request tail read so a long-lived intervention doesn't ship a
// multi-megabyte log on every reconnect. Same heuristic as sessions.
const MAX_INTERVENTION_TAIL_BYTES = 128 * 1024;

function mapError(err: unknown): TRPCError {
  if (err instanceof InterventionError) {
    if (
      err.code === "decision_not_found" ||
      err.code === "intervention_not_found" ||
      err.code === "source_run_not_found" ||
      err.code === "project_not_found"
    ) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (
      err.code === "intervention_already_active" ||
      err.code === "intervention_not_active" ||
      err.code === "decision_not_pending"
    ) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (err.code === "merge_failed") {
      return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : String(err),
  });
}

export const interventionsRouter = router({
  /**
   * Open a tmux session over the existing worktree of a blocked_run or
   * merge_failure decision. The decision stays pending; the operator
   * works in the tmux until they call `resume` or `cancel`.
   */
  start: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await startIntervention(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          input.decisionId,
        );
      } catch (err) {
        throw mapError(err);
      }
    }),

  /**
   * End the intervention and trigger its decision-kind action:
   *   - blocked_run    → submit a NEW run with --resume <sessionId>
   *   - merge_failure  → re-run mergeIntoMain
   * Marks the decision actioned on success.
   */
  resume: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await resumeFromIntervention(
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
        throw mapError(err);
      }
    }),

  /**
   * Tear down the tmux without running the resume action. Decision
   * stays pending; operator can intervene again, retry, or dismiss.
   */
  cancel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await cancelIntervention(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          input.id,
        );
        return { ok: true };
      } catch (err) {
        throw mapError(err);
      }
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const row = await ctx.db
      .select()
      .from(schema.interventions)
      .where(eq(schema.interventions.id, input.id))
      .get();
    return row ?? null;
  }),

  /**
   * Lookup the active intervention for a decision, if any. The PWA's
   * decision-detail polls this on every render so the right "intervene"
   * vs "resume / cancel" UI surfaces.
   */
  forDecision: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(schema.interventions)
        .where(
          and(
            eq(schema.interventions.decisionId, input.decisionId),
            eq(schema.interventions.status, "active"),
          ),
        )
        .orderBy(desc(schema.interventions.startedAt))
        .all();
      return rows[0] ?? null;
    }),

  /**
   * Read the tail of the intervention's tmux pipe-pane log so a
   * reconnecting PWA tab sees prior scrollback before live bytes
   * arrive (same pattern as sessions.tail).
   */
  tail: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const intervention = await ctx.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.id, input.id))
        .get();
      if (!intervention) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }

      const logPath = path.join(
        ctx.config.worktreesRoot,
        "_intervention-logs",
        `${intervention.id}.log`,
      );
      if (!existsSync(logPath)) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }
      const size = statSync(logPath).size;
      const start = input.offset ?? Math.max(0, size - MAX_INTERVENTION_TAIL_BYTES);
      const length = Math.min(MAX_INTERVENTION_TAIL_BYTES, Math.max(0, size - start));
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
