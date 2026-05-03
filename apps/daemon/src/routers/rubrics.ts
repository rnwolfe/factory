import { schema } from "@factory/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

export const rubricsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.rubricVersions)
      .where(eq(schema.rubricVersions.active, true))
      .all();
  }),

  history: protectedProcedure.input(z.object({ key: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select()
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
});
