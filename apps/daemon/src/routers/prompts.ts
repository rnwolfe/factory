import { schema } from "@factory/db";
import { and, desc, eq } from "drizzle-orm";
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
});
