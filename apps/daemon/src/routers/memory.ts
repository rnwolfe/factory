import {
  defaultOperatorMemoryPath,
  listMemoryFacts,
  readMemoryIndex,
} from "../memory/operator-memory.ts";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * Read-only view of the operator-memory repo (ADR-010 §4) for the PWA viewer.
 * The repo is Factory-canonical (a real git repo on disk); these endpoints just
 * surface it. Writes happen via operator-gated promotions, not here.
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
});
