import {
  defaultOperatorMemoryPath,
  listMemoryFacts,
  readMemoryIndex,
} from "../memory/operator-memory.ts";
import { seedOperatorMemory } from "../memory/seed.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { listHarnessSources } from "../watch/sources/registry.ts";

/**
 * Operator-memory repo (ADR-010 §4): a read-only view for the PWA viewer plus the
 * settings-triggered seed. The repo is Factory-canonical (a real git repo on disk);
 * fact writes otherwise happen via operator-gated promotions, not here.
 */
export const memoryRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const repoPath = defaultOperatorMemoryPath(ctx.config.workdir);
    return { repoPath, facts: await listMemoryFacts(repoPath) };
  }),

  index: protectedProcedure.query(async ({ ctx }) => {
    const repoPath = defaultOperatorMemoryPath(ctx.config.workdir);
    return { repoPath, text: await readMemoryIndex(repoPath) };
  }),

  /**
   * Settings-triggered "first seed": synthesize the operator's existing harness
   * memories into operator-memory facts (ADR-010 §4). Token-heavy + slow (one
   * synthesis call), so it runs in the BACKGROUND — the click returns the sources
   * it will read; the operator watches /memory fill. Errors are logged, not thrown
   * at the click. Re-runnable (writes are idempotent per slug).
   */
  seed: protectedProcedure.mutation(async ({ ctx }) => {
    const repoPath = defaultOperatorMemoryPath(ctx.config.workdir);
    const sources: string[] = [];
    for (const s of listHarnessSources()) {
      if (await s.isAvailable()) sources.push(s.id);
    }
    void seedOperatorMemory(repoPath, { budgetSeconds: 240 })
      .then((r) =>
        console.log(
          `[memory] seed: wrote ${r.factsWritten} fact(s) from ${r.memoriesRead} memory doc(s) across ${r.sources.join(", ") || "no sources"}`,
        ),
      )
      .catch((err) =>
        console.warn(`[memory] seed failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    return { started: true, sources };
  }),
});
