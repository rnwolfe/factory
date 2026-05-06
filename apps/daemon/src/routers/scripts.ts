import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readPackageScripts } from "../scripts/package-scripts.ts";
import { ScriptError } from "../scripts/registry.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const scriptsRouter = router({
  /** List package.json scripts available in this project's workdir. */
  listAvailable: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return [];
      return readPackageScripts(project.workdirPath);
    }),

  /** Active script handles for a project (or all projects if omitted). */
  active: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }))
    .query(({ ctx, input }) => ctx.scripts.active(input.projectId)),

  /** One handle by id (for the script-pane page). */
  get: protectedProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => {
    return ctx.scripts.get(input.id);
  }),

  start: protectedProcedure
    .input(z.object({ projectId: z.string(), scriptName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
      }
      const scripts = await readPackageScripts(project.workdirPath);
      const match = scripts.find((s) => s.scriptName === input.scriptName);
      if (!match) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `script ${input.scriptName} not in package.json`,
        });
      }
      try {
        return ctx.scripts.start({
          projectId: project.id,
          scriptName: match.scriptName,
          command: match.command,
          cwd: project.workdirPath,
        });
      } catch (err) {
        if (err instanceof ScriptError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  stop: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.scripts.stop(input.id);
    } catch (err) {
      if (err instanceof ScriptError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      throw err;
    }
  }),
});
