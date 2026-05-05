import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { RubricValidationError, validateRubricYaml } from "../rubrics/validate.ts";
import { protectedProcedure, router } from "../trpc.ts";

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return content.endsWith("\n") ? n - 1 : n;
}

export const rubricsRouter = router({
  /** All rubric keys the operator has touched, with their currently-active version. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = ctx.db
      .select()
      .from(schema.rubricVersions)
      .where(eq(schema.rubricVersions.active, true))
      .orderBy(schema.rubricVersions.rubricKey)
      .all();
    return rows.map((r) => ({
      id: r.id,
      rubricKey: r.rubricKey,
      version: r.version,
      promptKey: r.promptKey,
      active: r.active,
      createdAt: r.createdAt,
      lineCount: lineCount(r.yaml),
    }));
  }),

  history: protectedProcedure.input(z.object({ key: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select({
        id: schema.rubricVersions.id,
        rubricKey: schema.rubricVersions.rubricKey,
        version: schema.rubricVersions.version,
        active: schema.rubricVersions.active,
        createdAt: schema.rubricVersions.createdAt,
        message: schema.rubricVersions.message,
      })
      .from(schema.rubricVersions)
      .where(eq(schema.rubricVersions.rubricKey, input.key))
      .orderBy(desc(schema.rubricVersions.version))
      .all();
  }),

  get: protectedProcedure
    .input(z.object({ key: z.string(), version: z.number().int().optional() }))
    .query(async ({ ctx, input }) => {
      const where = input.version
        ? and(
            eq(schema.rubricVersions.rubricKey, input.key),
            eq(schema.rubricVersions.version, input.version),
          )
        : and(
            eq(schema.rubricVersions.rubricKey, input.key),
            eq(schema.rubricVersions.active, true),
          );
      return ctx.db.select().from(schema.rubricVersions).where(where).get() ?? null;
    }),

  /**
   * Save a new version of the rubric. Validates YAML shape; refuses to
   * insert on validation error. Does NOT activate — caller flips active
   * via `activateVersion`. Returns the new row.
   *
   * If the YAML matches the current active version verbatim, no row is
   * created — returns the existing active row.
   */
  upsertVersion: protectedProcedure
    .input(
      z.object({
        rubricKey: z.string().min(1).max(80),
        yaml: z.string().min(1).max(200_000),
        message: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let parsed: ReturnType<typeof validateRubricYaml>;
      try {
        parsed = validateRubricYaml(input.yaml);
      } catch (err) {
        if (err instanceof RubricValidationError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
      return ctx.db.transaction((tx) => {
        const existingActive = tx
          .select()
          .from(schema.rubricVersions)
          .where(
            and(
              eq(schema.rubricVersions.rubricKey, input.rubricKey),
              eq(schema.rubricVersions.active, true),
            ),
          )
          .get();
        if (existingActive && existingActive.yaml === input.yaml) {
          return { row: existingActive, created: false as const };
        }
        const maxRow = tx
          .select({ v: max(schema.rubricVersions.version) })
          .from(schema.rubricVersions)
          .where(eq(schema.rubricVersions.rubricKey, input.rubricKey))
          .get();
        const nextVersion = (maxRow?.v ?? 0) + 1;
        const id = createId();
        const promptKey = parsed.promptKey ?? existingActive?.promptKey ?? "triage-prompt-v1";
        tx.insert(schema.rubricVersions)
          .values({
            id,
            rubricKey: input.rubricKey,
            version: nextVersion,
            parentVersionId: existingActive?.id ?? null,
            yaml: input.yaml,
            promptKey,
            active: false,
            createdAt: Date.now(),
            message: input.message ?? null,
          })
          .run();
        const row = tx
          .select()
          .from(schema.rubricVersions)
          .where(eq(schema.rubricVersions.id, id))
          .get();
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "insert lost" });
        return { row, created: true as const };
      });
    }),

  /** Activate a previously-saved version. Atomic: one row up, one row down. */
  activateVersion: protectedProcedure
    .input(
      z.object({
        rubricKey: z.string().min(1).max(80),
        version: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction((tx) => {
        const target = tx
          .select()
          .from(schema.rubricVersions)
          .where(
            and(
              eq(schema.rubricVersions.rubricKey, input.rubricKey),
              eq(schema.rubricVersions.version, input.version),
            ),
          )
          .get();
        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `rubric ${input.rubricKey} v${input.version} not found`,
          });
        }
        if (target.active) return { row: target, changed: false as const };
        tx.update(schema.rubricVersions)
          .set({ active: false })
          .where(
            and(
              eq(schema.rubricVersions.rubricKey, input.rubricKey),
              eq(schema.rubricVersions.active, true),
            ),
          )
          .run();
        tx.update(schema.rubricVersions)
          .set({ active: true })
          .where(eq(schema.rubricVersions.id, target.id))
          .run();
        const row = tx
          .select()
          .from(schema.rubricVersions)
          .where(eq(schema.rubricVersions.id, target.id))
          .get();
        return { row: row ?? target, changed: true as const };
      });
    }),
});
