import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { listWorktrees, removeWorktreeAt } from "../projects/worktree-list.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const worktreesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listWorktrees(ctx.config, ctx.db);
  }),

  delete: protectedProcedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await removeWorktreeAt(ctx.config, ctx.db, input.path);
      if (!result.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: result.reason ?? "could not remove worktree",
        });
      }
      return { ok: true };
    }),
});
