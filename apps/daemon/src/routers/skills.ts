import path from "node:path";
import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  listProjectSkills,
  type ProjectSkillFile,
  readProjectSkill,
} from "../projects/project-skills.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { submitRun } from "../workers/submit.ts";

/**
 * Build the harness-agnostic directive that drives a skill run by injecting the
 * *resolved SKILL.md body* inline. The agent — claude-code or codex — runs
 * inside a checkout of the project, but we do not rely on any one harness's
 * native skill discovery (`.claude/skills/` is Claude Code-specific; codex has
 * no equivalent). Instead the skill's instructions ride in the prompt verbatim,
 * so the same skill executes identically under either agent.
 *
 * The skill's *directory* is still named so relative resource references inside
 * the body (bundled `scripts/…`, `reference/…`) resolve on disk.
 */
export function buildSkillRunDirective(skill: ProjectSkillFile, dirRelPath: string): string {
  return [
    `## Run the \`${skill.name}\` project skill`,
    "",
    "This run was launched to execute a project-local skill. Its instructions are",
    `inlined below verbatim from \`${dirRelPath}/SKILL.md\`. Treat them as`,
    "authoritative for *what* to do; this run's completion protocol governs *how*",
    "to report when you're finished.",
    "",
    `Bundled resources the skill references (e.g. \`scripts/…\`, \`reference/…\`) live`,
    `under \`${dirRelPath}/\` in this checkout — read them there as the skill directs.`,
    "",
    "---",
    "",
    skill.body,
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

      const skill = await readProjectSkill(project.workdirPath, input.skillName);
      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `skill ${input.skillName} not installed in this project`,
        });
      }

      // Directory the SKILL.md lives in, relative to the worktree root, so the
      // agent can reach bundled resources the body references.
      const dirRelPath = path.relative(project.workdirPath, path.dirname(skill.filePath));
      const directive = buildSkillRunDirective(skill, dirRelPath);

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
