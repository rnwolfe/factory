import { schema } from "@factory/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

export const promptsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: schema.prompts.id,
        promptKey: schema.prompts.promptKey,
        version: schema.prompts.version,
        active: schema.prompts.active,
        createdAt: schema.prompts.createdAt,
      })
      .from(schema.prompts)
      .where(eq(schema.prompts.active, true))
      .orderBy(schema.prompts.promptKey)
      .all();
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
});
