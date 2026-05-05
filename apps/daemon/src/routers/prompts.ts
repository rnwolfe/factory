import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  // Trailing newline shouldn't count as a separate line.
  return content.endsWith("\n") ? n - 1 : n;
}

export const promptsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = ctx.db
      .select({
        id: schema.prompts.id,
        promptKey: schema.prompts.promptKey,
        version: schema.prompts.version,
        active: schema.prompts.active,
        createdAt: schema.prompts.createdAt,
        content: schema.prompts.content,
      })
      .from(schema.prompts)
      .where(eq(schema.prompts.active, true))
      .orderBy(schema.prompts.promptKey)
      .all();
    return rows.map((r) => ({
      id: r.id,
      promptKey: r.promptKey,
      version: r.version,
      active: r.active,
      createdAt: r.createdAt,
      lineCount: lineCount(r.content),
    }));
  }),

  history: protectedProcedure.input(z.object({ key: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select({
        id: schema.prompts.id,
        promptKey: schema.prompts.promptKey,
        version: schema.prompts.version,
        active: schema.prompts.active,
        createdAt: schema.prompts.createdAt,
      })
      .from(schema.prompts)
      .where(eq(schema.prompts.promptKey, input.key))
      .orderBy(desc(schema.prompts.version))
      .all();
  }),

  get: protectedProcedure
    .input(z.object({ key: z.string(), version: z.number().int().optional() }))
    .query(async ({ ctx, input }) => {
      const where = input.version
        ? and(eq(schema.prompts.promptKey, input.key), eq(schema.prompts.version, input.version))
        : and(eq(schema.prompts.promptKey, input.key), eq(schema.prompts.active, true));
      return ctx.db.select().from(schema.prompts).where(where).get() ?? null;
    }),

  /**
   * Save the operator's edit as a new version and activate it. Atomic:
   * the prior active row is deactivated and the new row inserted in one
   * transaction so concurrent runners never see two active rows or zero
   * active rows. Returns the new row.
   *
   * If `content` matches the current active version verbatim, no row is
   * created — returns the existing active row. Lets the editor's "save"
   * be idempotent on no-op edits.
   */
  upsertVersion: protectedProcedure
    .input(
      z.object({
        promptKey: z.string().min(1).max(80),
        content: z.string().min(1).max(200_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction((tx) => {
        const existingActive = tx
          .select()
          .from(schema.prompts)
          .where(
            and(eq(schema.prompts.promptKey, input.promptKey), eq(schema.prompts.active, true)),
          )
          .get();
        if (existingActive && existingActive.content === input.content) {
          return { row: existingActive, created: false as const };
        }
        const maxRow = tx
          .select({ v: max(schema.prompts.version) })
          .from(schema.prompts)
          .where(eq(schema.prompts.promptKey, input.promptKey))
          .get();
        const nextVersion = (maxRow?.v ?? 0) + 1;
        if (existingActive) {
          tx.update(schema.prompts)
            .set({ active: false })
            .where(eq(schema.prompts.id, existingActive.id))
            .run();
        }
        const id = createId();
        tx.insert(schema.prompts)
          .values({
            id,
            promptKey: input.promptKey,
            version: nextVersion,
            content: input.content,
            active: true,
            createdAt: Date.now(),
          })
          .run();
        const row = tx.select().from(schema.prompts).where(eq(schema.prompts.id, id)).get();
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "insert lost" });
        return { row, created: true as const };
      });
    }),

  /**
   * Switch active to a previously-recorded version. Used for rollback.
   * The currently-active row is deactivated and the chosen version is
   * activated, atomically. No-op if the chosen version is already active.
   */
  activateVersion: protectedProcedure
    .input(
      z.object({
        promptKey: z.string().min(1).max(80),
        version: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction((tx) => {
        const target = tx
          .select()
          .from(schema.prompts)
          .where(
            and(
              eq(schema.prompts.promptKey, input.promptKey),
              eq(schema.prompts.version, input.version),
            ),
          )
          .get();
        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `prompt ${input.promptKey} v${input.version} not found`,
          });
        }
        if (target.active) return { row: target, changed: false as const };
        tx.update(schema.prompts)
          .set({ active: false })
          .where(
            and(eq(schema.prompts.promptKey, input.promptKey), eq(schema.prompts.active, true)),
          )
          .run();
        tx.update(schema.prompts)
          .set({ active: true })
          .where(eq(schema.prompts.id, target.id))
          .run();
        const row = tx.select().from(schema.prompts).where(eq(schema.prompts.id, target.id)).get();
        return { row: row ?? target, changed: true as const };
      });
    }),
});
