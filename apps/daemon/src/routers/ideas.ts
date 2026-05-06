import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { runTriage } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";

const CeremonyEnum = z.enum(["tinker", "personal", "shared", "production"]);
const RoleEnum = z.enum(["owner", "contributor"]);

export const ideasRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        rawText: z.string().min(1).max(8000),
        intentCeremony: CeremonyEnum.optional(),
        intentRole: RoleEnum.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ideaId = createId();
      const now = Date.now();
      await ctx.db.insert(schema.ideas).values({
        id: ideaId,
        rawText: input.rawText,
        intentCeremony: input.intentCeremony ?? null,
        intentRole: input.intentRole ?? null,
        source: "pwa",
        createdAt: now,
      });

      // Surface immediately so the inbox can render a "triaging" row.
      ctx.events.publish({ channel: "inbox", kind: "idea_captured", ideaId });

      // Fire-and-forget triage. Surfaces as a decisions row + WS push.
      void (async () => {
        try {
          const { decisionId } = await runTriage(ctx.db, {
            ideaId,
            rawText: input.rawText,
            intentCeremony: input.intentCeremony,
            intentRole: input.intentRole,
          });
          ctx.events.publish({ channel: "inbox", kind: "decision_created", decisionId });
        } catch (err) {
          // Surface as a failure decision so nothing fails silently. Stamp
          // triagedAt on the idea so it stops appearing in the triaging list.
          const decisionId = createId();
          const now = Date.now();
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
            createdAt: now,
          });
          await ctx.db
            .update(schema.ideas)
            .set({ triagedAt: now })
            .where(eq(schema.ideas.id, ideaId));
          ctx.events.publish({ channel: "inbox", kind: "decision_created", decisionId });
        }
      })();

      return { ideaId };
    }),

  triaging: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.ideas)
      .where(isNull(schema.ideas.triagedAt))
      .orderBy(desc(schema.ideas.createdAt))
      .all();
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
