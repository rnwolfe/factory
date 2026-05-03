import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { executeRun } from "../workers/runner.ts";

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  /** True for renamed/moved files (numstat reports `path1 => path2`). */
  renamed: boolean;
}

interface RunDiff {
  base: string | null;
  branch: string;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  commits: Array<{ sha: string; subject: string; ts: number; author: string }>;
}

export const runsRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.projectId, input.projectId))
        .orderBy(desc(schema.runs.startedAt))
        .limit(100)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(schema.runs).where(eq(schema.runs.id, input.id)).get() ?? null;
  }),

  start: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string().optional(),
        prompt: z.string().optional(),
        budgetSeconds: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");

      const runId = createId();
      const now = Date.now();
      const branch = `factory/run-${runId}`;
      // Worktrees live outside the project workdir so `git status` on the
      // canonical project stays clean. One subdir per project keeps the layout
      // browsable.
      const worktreePath = `${ctx.config.worktreesRoot}/${project.slug}/${runId}`;
      await ctx.db.insert(schema.runs).values({
        id: runId,
        projectId: project.id,
        taskId: input.taskId ?? null,
        status: "queued",
        agentName: "claude-code",
        branch,
        worktreePath,
        startedAt: now,
        budgetSeconds: input.budgetSeconds ?? ctx.config.defaultRunBudgetSeconds,
      });

      void ctx.pool.submit(async () => {
        await executeRun(
          { config: ctx.config, db: ctx.db, events: ctx.events, runs: ctx.runs },
          runId,
        );
      });

      return { runId };
    }),

  abort: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const ok = ctx.runs.abort(input.id);
    return { ok };
  }),

  diff: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<RunDiff | null> => {
      const run = await ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, input.runId))
        .get();
      if (!run) return null;
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, run.projectId))
        .get();
      if (!project) return null;

      // Best-effort base: project's main HEAD. The branch was forked from there.
      const base = await runGit(["rev-parse", "main"], project.workdirPath);
      const baseRef = base.exitCode === 0 ? base.stdout.trim() : null;

      const range = baseRef ? `${baseRef}..${run.branch}` : run.branch;
      const numstat = await runGit(["diff", "--numstat", "--no-color", range], project.workdirPath);

      const files: DiffFile[] = [];
      let totalAdditions = 0;
      let totalDeletions = 0;
      if (numstat.exitCode === 0) {
        for (const raw of numstat.stdout.split("\n")) {
          if (raw.length === 0) continue;
          const parts = raw.split("\t");
          if (parts.length < 3) continue;
          // Binary files report `-` for both — coerce to 0.
          const adds = Number.parseInt(parts[0] ?? "0", 10) || 0;
          const dels = Number.parseInt(parts[1] ?? "0", 10) || 0;
          const p = parts.slice(2).join("\t");
          const renamed = p.includes(" => ");
          files.push({ path: p, additions: adds, deletions: dels, renamed });
          totalAdditions += adds;
          totalDeletions += dels;
        }
      }

      const log = await runGit(
        [
          "log",
          baseRef ? `${baseRef}..${run.branch}` : run.branch,
          "--pretty=format:%H%x09%s%x09%at%x09%an",
        ],
        project.workdirPath,
      );
      const commits: RunDiff["commits"] = [];
      if (log.exitCode === 0) {
        for (const raw of log.stdout.split("\n")) {
          if (raw.length === 0) continue;
          const parts = raw.split("\t");
          if (parts.length < 4) continue;
          commits.push({
            sha: parts[0] ?? "",
            subject: parts[1] ?? "",
            ts: Number.parseInt(parts[2] ?? "0", 10) * 1000,
            author: parts[3] ?? "",
          });
        }
      }

      return {
        base: baseRef,
        branch: run.branch,
        files,
        totalAdditions,
        totalDeletions,
        commits,
      };
    }),

  events: protectedProcedure
    .input(
      z.object({
        runId: z.string(),
        since: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const sinceFilter = input.since
        ? and(eq(schema.events.runId, input.runId), gt(schema.events.id, input.since))
        : eq(schema.events.runId, input.runId);
      return ctx.db
        .select()
        .from(schema.events)
        .where(sinceFilter)
        .orderBy(asc(schema.events.id))
        .limit(2000)
        .all();
    }),
});
