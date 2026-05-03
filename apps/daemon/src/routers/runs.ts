import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { schema } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { submitRun } from "../workers/submit.ts";

const MAX_RAW_LOG_BYTES = 256 * 1024;

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
      return submitRun(
        {
          config: ctx.config,
          db: ctx.db,
          events: ctx.events,
          runs: ctx.runs,
          pool: ctx.pool,
        },
        input,
      );
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

  rawLog: protectedProcedure
    .input(
      z.object({
        runId: z.string(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const run = await ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, input.runId))
        .get();
      if (!run) return { content: "", offset: 0, size: 0, truncated: false };
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, run.projectId))
        .get();
      if (!project) return { content: "", offset: 0, size: 0, truncated: false };

      const logPath = path.join(project.workdirPath, ".factory", "runs", input.runId, "log.txt");
      if (!existsSync(logPath)) {
        return { content: "", offset: 0, size: 0, truncated: false };
      }
      const size = statSync(logPath).size;
      const start = input.offset ?? Math.max(0, size - MAX_RAW_LOG_BYTES);
      const length = Math.min(MAX_RAW_LOG_BYTES, Math.max(0, size - start));
      if (length === 0) {
        return { content: "", offset: size, size, truncated: false };
      }
      const fh = await open(logPath, "r");
      try {
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, start);
        return {
          content: buf.toString("utf8"),
          offset: start + length,
          size,
          truncated: start > 0,
        };
      } finally {
        await fh.close();
      }
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
