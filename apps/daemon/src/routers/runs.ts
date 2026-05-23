import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { schema } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { tmuxSessionNameFor } from "../workers/recover.ts";
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
        budgetSeconds: z.number().int().nonnegative().optional(),
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
    // Best path: signal the in-memory AbortController. The runtime catches it,
    // tears down the tmux session, and updates the row to `aborted`.
    const signaled = ctx.runs.abort(input.id);

    const row = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, input.id)).get();
    if (!row) return { ok: false, signaled: false };

    // Force path: if the AC was missing (e.g., daemon was restarted while
    // this run was active), the runtime can't help. The operator's intent
    // is unambiguous, so we mark the row aborted ourselves and best-effort
    // kill the orphaned tmux session.
    if (!signaled && (row.status === "running" || row.status === "queued")) {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, row.projectId))
        .get();
      if (project) {
        try {
          const proc = bunSpawn({
            cmd: ["tmux", "kill-session", "-t", tmuxSessionNameFor(project.slug, input.id)],
            stdout: "pipe",
            stderr: "pipe",
          });
          await proc.exited;
        } catch {
          // best-effort
        }
      }
      await ctx.db
        .update(schema.runs)
        .set({
          status: "aborted",
          endedAt: Date.now(),
          summary: "Run force-aborted by operator (runtime was no longer registered).",
        })
        .where(eq(schema.runs.id, input.id));
      ctx.events.publish({ channel: "inbox", kind: "decision_updated", decisionId: input.id });
    }

    return { ok: true, signaled };
  }),

  /**
   * Submit a new run that resumes from a prior run's branch tip. Use case:
   * the source run blocked or failed and the operator wants the agent to
   * pick up where it left off (including any auto-committed partial work)
   * rather than start fresh from project HEAD.
   */
  retry: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, input.runId))
        .get();
      if (!source) throw new Error("source run not found");
      if (source.status !== "blocked" && source.status !== "failed") {
        throw new Error(`cannot retry a ${source.status} run`);
      }
      return submitRun(
        {
          config: ctx.config,
          db: ctx.db,
          events: ctx.events,
          runs: ctx.runs,
          pool: ctx.pool,
        },
        {
          projectId: source.projectId,
          taskId: source.taskId ?? undefined,
          baseRef: source.branch,
        },
      );
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

      // Resolve the diff base. Preference order:
      //
      // 1. `run.baseRef` — the sha captured at run creation in submit.ts.
      //    Exact fork point, stable across any later history rewrites or
      //    merges. This is the only path that works correctly for runs
      //    successfully merged into main via `--no-ff`.
      //
      // 2. Parent of the run's oldest commit (from the events log) — for
      //    historical runs created before baseRef was captured. The events
      //    table persists every commit the run made, so we can reconstruct
      //    the fork point as <oldest-commit>^.
      //
      // 3. `git merge-base main <branch>` — final fallback. Works for runs
      //    whose branches were never merged into main. Returns the branch
      //    tip after a `--no-ff` merge (and then `branch-tip..branch` is
      //    empty), which is the original bug — but it still beats nothing
      //    for the pre-baseRef historical case where no commits were made.
      //
      // 4. `git rev-parse main` — last-resort default.
      let baseRef: string | null = run.baseRef ?? null;

      if (!baseRef) {
        const oldest = await ctx.db
          .select({ payload: schema.events.payload })
          .from(schema.events)
          .where(and(eq(schema.events.runId, run.id), eq(schema.events.kind, "commit")))
          .orderBy(schema.events.ts)
          .limit(1)
          .get();
        if (oldest) {
          try {
            const raw = typeof oldest.payload === "string" ? oldest.payload : "";
            const parsed = (raw ? JSON.parse(raw) : {}) as { sha?: string };
            if (parsed.sha) {
              const parent = await runGit(
                ["rev-parse", "--verify", `${parsed.sha}^`],
                project.workdirPath,
              );
              if (parent.exitCode === 0) baseRef = parent.stdout.trim();
            }
          } catch {
            // malformed payload; fall through
          }
        }
      }

      if (!baseRef) {
        const mb = await runGit(["merge-base", "main", run.branch], project.workdirPath);
        baseRef = mb.exitCode === 0 ? mb.stdout.trim() : null;
      }
      if (!baseRef) {
        const head = await runGit(["rev-parse", "main"], project.workdirPath);
        baseRef = head.exitCode === 0 ? head.stdout.trim() : null;
      }

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
        ["log", range, "--pretty=format:%H%x09%s%x09%at%x09%an"],
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
        /** Hard cap. Default 400 — keeps the response under ~4MB even with
         *  long text events; matches the client-side display cap. */
        limit: z.number().int().min(1).max(2000).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const limit = input.limit ?? 400;
      const sinceFilter = input.since
        ? and(eq(schema.events.runId, input.runId), gt(schema.events.id, input.since))
        : eq(schema.events.runId, input.runId);
      // Order DESC + reverse below. Without this, "limit 400 ordered ASC"
      // would return the FIRST 400 events instead of the most-recent 400 —
      // operators care about the tail, not the head.
      const rows = await ctx.db
        .select({ id: schema.events.id, payload: schema.events.payload })
        .from(schema.events)
        .where(sinceFilter)
        .orderBy(desc(schema.events.id))
        .limit(limit)
        .all();

      // Truncate text-event payloads server-side. A single agent text event
      // can be 100KB+; over the wire that becomes the bottleneck. The raw
      // xterm view preserves the full stream — the structured view is a
      // summary, so capped text is fine. Non-text payloads (tool, commit,
      // metrics, etc.) are passed through unchanged.
      const TEXT_CAP = 4_000;
      const trimmed = rows.map((row) => {
        const payload = row.payload as { kind?: string; text?: string } | null;
        if (
          payload &&
          payload.kind === "text" &&
          typeof payload.text === "string" &&
          payload.text.length > TEXT_CAP
        ) {
          return {
            id: row.id,
            payload: {
              ...payload,
              text: `${payload.text.slice(0, TEXT_CAP)}\n\n[truncated — ${payload.text.length - TEXT_CAP} more chars, see raw view]`,
            },
          };
        }
        return row;
      });

      // Reverse so the client gets chronological order without re-sorting.
      return trimmed.reverse();
    }),
});
