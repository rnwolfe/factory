import path from "node:path";
import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { findProjectSkill, listProjectSkills } from "../projects/project-skills.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { submitRun } from "../workers/submit.ts";

/**
 * Build the harness-agnostic directive that drives a skill run. The agent —
 * claude-code or codex — runs inside a checkout of the project, so we point it
 * at the SKILL.md path relative to the worktree root and ask it to read and
 * execute the skill. No reliance on any one harness's auto-discovery: "read
 * this file and follow it" works the same for every agent.
 */
function buildSkillRunDirective(skillName: string, relPath: string): string {
  return [
    `## Run the \`${skillName}\` project skill`,
    "",
    "This run was launched to execute a project-local skill. The skill definition",
    `lives in this repo at \`${relPath}\`.`,
    "",
    `1. Read \`${relPath}\` — it is the skill's instructions.`,
    "2. Carry out the skill's workflow to completion for this project.",
    "3. Treat the skill file as authoritative for *what* to do; this run's",
    "   completion protocol governs *how* to report when you're finished.",
  ].join("\n");
}

export const skillsRouter = router({
  /**
   * Discovered project skills for a project, scoped (keyed) by project id.
   * Mirrors `audits.listSkills`: reads the repo-canonical
   * `<project>/.claude/skills/<name>/SKILL.md` set at query time. Unknown project →
   * empty list (the page renders "no skills" rather than erroring).
   */
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return [];
      return listProjectSkills(project.workdirPath);
    }),

  /**
   * Launch a run that executes the named project skill. Mirrors
   * `audits.submit`: validate the skill is installed, then create the
   * execution. The run goes through `submitRun`, which resolves the project's
   * fused `{agent, model}` via the standard chain (project → settings →
   * default) — no task is attached, so a skill run inherits exactly what an
   * ad-hoc run on this project would.
   */
  submit: protectedProcedure
    .input(z.object({ projectId: z.string(), skillName: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      const skill = await findProjectSkill(project.workdirPath, input.skillName);
      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `skill ${input.skillName} not installed in this project`,
        });
      }

      const relPath = path.relative(project.workdirPath, skill.filePath);
      const directive = buildSkillRunDirective(skill.name, relPath);

      return submitRun(
        {
          config: ctx.config,
          db: ctx.db,
          events: ctx.events,
          runs: ctx.runs,
          pool: ctx.pool,
        },
        { projectId: project.id, operatorContext: directive },
      );
    }),
});
