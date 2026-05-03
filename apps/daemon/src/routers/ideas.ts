import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { runTriage } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

const GoalEnum = z.enum(["me", "learn", "share", "productize"]);

export const ideasRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        rawText: z.string().min(1).max(8000),
        goalHint: GoalEnum.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ideaId = createId();
      const now = Date.now();
      await ctx.db.insert(schema.ideas).values({
        id: ideaId,
        rawText: input.rawText,
        goalHint: input.goalHint ?? null,
        source: "pwa",
        createdAt: now,
      });

      // Fire-and-forget triage. Surfaces as a decisions row + WS push.
      void (async () => {
        try {
          const { decisionId } = await runTriage(ctx.db, {
            ideaId,
            rawText: input.rawText,
            goalHint: input.goalHint,
          });
          ctx.events.publish({ channel: "inbox", kind: "decision_created", decisionId });
        } catch (err) {
          // Surface as a failure decision so nothing fails silently.
          const decisionId = createId();
          await ctx.db.insert(schema.decisions).values({
            id: decisionId,
            kind: "triage",
            ideaId,
            outcome: "trashed",
            payload: {
              outcome: "trashed",
              rationale: `Triage failed: ${(err as Error).message}`,
              what_would_change_verdict: "Re-run triage after the underlying error is fixed.",
            },
            status: "pending",
            createdAt: Date.now(),
          });
          ctx.events.publish({ channel: "inbox", kind: "decision_created", decisionId });
        }
      })();

      return { ideaId };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.ideas)
      .orderBy(desc(schema.ideas.createdAt))
      .limit(100)
      .all();
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(schema.ideas).where(eq(schema.ideas.id, input.id)).get() ?? null;
  }),
});
