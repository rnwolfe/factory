import { z } from "zod";
import { buildInterventionPrompt } from "../recovery-prompts/prompts.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const recoveryPromptsRouter = router({
  /**
   * Build a copy-pastable operator-intervention prompt for a decision that
   * needs human help. Returns `null` for decision kinds that don't need an
   * intervention prompt (tag changes, triage, agent decisions) so the
   * decision card can hide the block in those cases.
   *
   * The prompt body is scenario-specific (merge-conflict vs. blocked-with-
   * questions vs. dirty-tree merge, etc.). Each scenario carries enough
   * context — worktree path, branch, base ref, conflicted files, the
   * questions the agent asked, the task body — that an operator can paste
   * the prompt straight into an interactive Claude or codex session and
   * have everything they need to drive the recovery.
   */
  forDecision: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return buildInterventionPrompt(ctx.db, input.decisionId);
    }),
});
