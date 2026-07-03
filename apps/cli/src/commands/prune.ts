import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { run } from "../lib/exec.ts";
import { unitPath } from "../lib/unit.ts";

export interface PruneArgs {
  apply: boolean;
  includeFailed: boolean;
  project: string | null;
  ageDays: number;
  logsOlderThan: number;
  help: boolean;
}

const DEFAULT_LOGS_OLDER_THAN_DAYS = 30;

const PRUNE_HELP = `factory prune — reclaim disk from terminal runs

usage:
  factory prune [options]

options:
  --apply                  actually remove artifacts (default: dry-run preview)
  --include-failed         also clean failed/blocked/aborted/usage_capped/deferred
                           runs (default: only completed runs)
  --project=<slug>         limit to a single project
  --age=<days>             only clean worktrees older than N days
  --logs-older-than=<days> only sweep per-run log dirs older than N days
                           (default: ${DEFAULT_LOGS_OLDER_THAN_DAYS})
  --help, -h               this message

Removes three run-scoped artifacts: the worktree directory, the run's
\`factory/run-<id>\` branch ref, and its \`.factory/runs/<id>/\` log dir.

A branch ref is deleted ONLY when its work is safe to lose from the ref —
the run merged to main (the merge commit preserves history) or the branch
has no commits beyond its base. A failed/blocked run whose branch still
carries unmerged commits keeps its branch: it's the retry/salvage substrate.
Only \`factory/run-*\` branches are ever touched; operator-named branches are
left alone.

Log dirs are swept for terminal runs older than --logs-older-than; the log
dirs of queued/running/blocked runs are never touched (the boot reaper reads
them to salvage in-flight runs after a restart). Runs with status
running/queued are never touched at all.
`;

export function parsePruneArgs(argv: string[]): PruneArgs {
  let apply = false;
  let includeFailed = false;
  let project: string | null = null;
  let ageDays = 0;
  let logsOlderThan = DEFAULT_LOGS_OLDER_THAN_DAYS;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--apply") apply = true;
    else if (a === "--include-failed") includeFailed = true;
    else if (a === "--project") project = argv[++i] ?? null;
    else if (a?.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--age") ageDays = Number(argv[++i] ?? 0);
    else if (a?.startsWith("--age=")) ageDays = Number(a.slice("--age=".length));
    else if (a === "--logs-older-than") logsOlderThan = Number(argv[++i] ?? logsOlderThan);
    else if (a?.startsWith("--logs-older-than="))
      logsOlderThan = Number(a.slice("--logs-older-than=".length));
  }
  return { apply, includeFailed, project, ageDays, logsOlderThan, help };
}

/**
 * Locate FACTORY_HOME. Priority: env > unit file's Environment= line > default.
 * The unit-file path covers operators who don't export FACTORY_HOME in their
 * interactive shell — same auto-discovery the upgrade flow uses.
 */
async function resolveFactoryHome(): Promise<string> {
  const env = process.env.FACTORY_HOME;
  if (env && env.length > 0) return env;
  const p = unitPath();
  if (existsSync(p)) {
    try {
      const text = await readFile(p, "utf8");
      const m = text.match(/^Environment=FACTORY_HOME=(.+)$/m);
      if (m?.[1]?.trim()) return m[1].trim();
    } catch {
      // fall through
    }
  }
  return path.join(os.homedir(), ".factory");
}

const SAFE_STATUSES = ["completed"] as const;
const ALL_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "aborted",
  "usage_capped",
  "deferred",
] as const;

interface RunRow {
  id: string;
  status: string;
  branch: string;
  worktree_path: string;
  ended_at: number | null;
  slug: string;
  workdir_path: string;
}

interface Candidate {
  runId: string;
  status: string;
  branch: string;
  worktreePath: string;
  projectSlug: string;
  projectWorkdir: string;
  endedAt: number;
  sizeBytes: number;
  /** True when this run's branch ref is safe to delete (merged or empty). */
  branchDeletable: boolean;
}

interface LogRow {
  id: string;
  status: string;
  ended_at: number | null;
  slug: string;
  workdir_path: string;
}

interface LogCandidate {
  runId: string;
  status: string;
  projectSlug: string;
  logDir: string;
  endedAt: number;
  sizeBytes: number;
}

async function dirSizeBytes(p: string): Promise<number> {
  const r = await run(["du", "-sb", p]);
  if (r.exitCode !== 0) return 0;
  const first = r.stdout.split("\t")[0] ?? "0";
  return Number.parseInt(first, 10) || 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(2)}G`;
}

function ageOf(endedAt: number): string {
  const days = (Date.now() - endedAt) / 86_400_000;
  if (days < 1) return `${Math.max(1, Math.floor(days * 24))}h`;
  return `${Math.floor(days)}d`;
}

async function selectCandidates(args: PruneArgs, dbPath: string): Promise<Candidate[]> {
  const statuses = args.includeFailed ? ALL_TERMINAL_STATUSES : SAFE_STATUSES;
  const ageCutoff =
    args.ageDays > 0 ? Date.now() - args.ageDays * 86_400_000 : Number.POSITIVE_INFINITY;

  const db = new Database(dbPath, { readonly: true });
  try {
    // SQLite parameter binding for the IN clause; one '?' per status.
    const placeholders = statuses.map(() => "?").join(",");
    const sql = `
      SELECT r.id, r.status, r.branch, r.worktree_path, r.ended_at,
             p.slug, p.workdir_path
      FROM runs r
      JOIN projects p ON p.id = r.project_id
      WHERE r.status IN (${placeholders})
        AND r.ended_at IS NOT NULL
        AND r.worktree_path != ''
      ORDER BY r.ended_at ASC
    `;
    const rows = db.prepare(sql).all(...statuses) as RunRow[];

    const candidates: Candidate[] = [];
    for (const r of rows) {
      if (args.project && r.slug !== args.project) continue;
      if (r.ended_at == null) continue;
      if (args.ageDays > 0 && r.ended_at > ageCutoff) continue;
      if (!existsSync(r.worktree_path)) continue; // already cleaned up
      candidates.push({
        runId: r.id,
        status: r.status,
        branch: r.branch,
        worktreePath: r.worktree_path,
        projectSlug: r.slug,
        projectWorkdir: r.workdir_path,
        endedAt: r.ended_at,
        sizeBytes: 0,
        branchDeletable: false,
      });
    }
    return candidates;
  } finally {
    db.close();
  }
}

/**
 * A run's branch ref is safe to delete only when losing the ref loses nothing:
 * the branch merged to main (the `--no-ff` merge commit's second parent is the
 * branch tip, so the tip is an ancestor of main) OR the branch has no commits
 * beyond its base (tip == base, still an ancestor of main). A failed/blocked/
 * needs_review branch that carries unmerged commits is NOT an ancestor of main
 * and is kept — it's the retry/salvage substrate (CLAUDE.md). Only auto-generated
 * `factory/run-*` branches are ever considered; operator-named branches are left
 * alone. When `main` is absent the ancestry check errors → kept (safe default).
 *
 * Mirrors runtime's `deleteBranch` (`git branch -D`); the CLI shells git directly
 * to stay free of a workspace dependency, matching the `git worktree remove`
 * calls already in this file.
 */
async function isBranchDeletable(projectWorkdir: string, branch: string): Promise<boolean> {
  if (!branch.startsWith("factory/run-")) return false;
  const exists = await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectWorkdir,
  });
  if (exists.exitCode !== 0) return false; // ref already gone
  const ancestor = await run(["git", "merge-base", "--is-ancestor", branch, "main"], {
    cwd: projectWorkdir,
  });
  return ancestor.exitCode === 0;
}

async function selectLogCandidates(args: PruneArgs, dbPath: string): Promise<LogCandidate[]> {
  const statuses = args.includeFailed ? ALL_TERMINAL_STATUSES : SAFE_STATUSES;
  // `blocked` log dirs are protected: the boot reaper reads persisted logs to
  // salvage in-flight/blocked runs after a restart. queued/running never appear
  // in the terminal-status sets above, so filtering `blocked` is sufficient.
  const logStatuses = statuses.filter((s) => s !== "blocked");
  const cutoff = args.logsOlderThan > 0 ? Date.now() - args.logsOlderThan * 86_400_000 : Date.now();

  const db = new Database(dbPath, { readonly: true });
  try {
    const placeholders = logStatuses.map(() => "?").join(",");
    const sql = `
      SELECT r.id, r.status, r.ended_at, p.slug, p.workdir_path
      FROM runs r
      JOIN projects p ON p.id = r.project_id
      WHERE r.status IN (${placeholders})
        AND r.ended_at IS NOT NULL
      ORDER BY r.ended_at ASC
    `;
    const rows = db.prepare(sql).all(...logStatuses) as LogRow[];

    const candidates: LogCandidate[] = [];
    for (const r of rows) {
      if (args.project && r.slug !== args.project) continue;
      if (r.ended_at == null || r.ended_at > cutoff) continue;
      const logDir = path.join(r.workdir_path, ".factory", "runs", r.id);
      if (!existsSync(logDir)) continue; // already swept
      candidates.push({
        runId: r.id,
        status: r.status,
        projectSlug: r.slug,
        logDir,
        endedAt: r.ended_at,
        sizeBytes: 0,
      });
    }
    return candidates;
  } finally {
    db.close();
  }
}

function groupBy<T, K extends string>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k) ?? [];
    list.push(it);
    out.set(k, list);
  }
  return out;
}

export async function runPrune(args: PruneArgs): Promise<number> {
  if (args.help) {
    process.stdout.write(PRUNE_HELP);
    return 0;
  }

  const home = await resolveFactoryHome();
  const dbPath = path.join(home, "data.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`factory: ${dbPath} does not exist — has the daemon ever run?\n`);
    return 1;
  }

  const candidates = await selectCandidates(args, dbPath);
  const logCandidates = await selectLogCandidates(args, dbPath);

  // Size + branch-deletability computation in parallel — bounded by candidate
  // count, which is small (tens, not thousands); du and git are fast per-run.
  await Promise.all([
    ...candidates.map(async (c) => {
      c.sizeBytes = await dirSizeBytes(c.worktreePath);
      c.branchDeletable = await isBranchDeletable(c.projectWorkdir, c.branch);
    }),
    ...logCandidates.map(async (c) => {
      c.sizeBytes = await dirSizeBytes(c.logDir);
    }),
  ]);

  const deletableBranches = candidates.filter((c) => c.branchDeletable).length;

  process.stdout.write(`factory prune (${args.apply ? "apply" : "dry-run"}):\n`);
  if (candidates.length === 0 && logCandidates.length === 0) {
    process.stdout.write("\nnothing to clean. ");
    if (!args.includeFailed) {
      process.stdout.write("add --include-failed to also consider failed/blocked/aborted runs.\n");
    } else {
      process.stdout.write("no terminal-status worktrees or stale log dirs on disk.\n");
    }
    return 0;
  }

  // Worktrees + branch refs.
  let totalBytes = 0;
  if (candidates.length > 0) {
    for (const [slug, list] of groupBy(candidates, (c) => c.projectSlug)) {
      process.stdout.write(`\n  ${slug}:\n`);
      for (const c of list) {
        const size = formatBytes(c.sizeBytes).padStart(7);
        const age = ageOf(c.endedAt).padStart(4);
        const branchTag = c.branchDeletable ? "branch:del" : "branch:keep";
        process.stdout.write(
          `    ${c.runId.slice(0, 12)} [${c.status.padEnd(12)}] ${size} ${age}  ${branchTag}\n`,
        );
        totalBytes += c.sizeBytes;
      }
    }
    const verb = args.apply ? "removing" : "would remove";
    process.stdout.write(
      `\n${verb}: ${candidates.length} worktrees · ${formatBytes(totalBytes)} · ${deletableBranches} branch refs\n`,
    );
  }

  // Stale per-run log dirs.
  let logBytes = 0;
  if (logCandidates.length > 0) {
    process.stdout.write(`\nstale log dirs (older than ${args.logsOlderThan}d):\n`);
    for (const [slug, list] of groupBy(logCandidates, (c) => c.projectSlug)) {
      process.stdout.write(`\n  ${slug}:\n`);
      for (const c of list) {
        const size = formatBytes(c.sizeBytes).padStart(7);
        const age = ageOf(c.endedAt).padStart(4);
        process.stdout.write(
          `    ${c.runId.slice(0, 12)} [${c.status.padEnd(12)}] ${size} ${age}\n`,
        );
        logBytes += c.sizeBytes;
      }
    }
    const verb = args.apply ? "removing" : "would remove";
    process.stdout.write(
      `\n${verb}: ${logCandidates.length} log dirs · ${formatBytes(logBytes)}\n`,
    );
  }

  if (!args.apply) {
    process.stdout.write("\nre-run with --apply to remove\n");
    if (!args.includeFailed) {
      process.stdout.write("add --include-failed to also clean failed/blocked/aborted runs\n");
    }
    return 0;
  }

  // Apply phase.
  let removed = 0;
  let failed = 0;
  let branchesDeleted = 0;
  for (const c of candidates) {
    let worktreeGone = false;
    const wr = await run(["git", "worktree", "remove", "--force", c.worktreePath], {
      cwd: c.projectWorkdir,
    });
    if (wr.exitCode === 0) {
      removed++;
      worktreeGone = true;
    } else {
      // Filesystem fallback: directory might be detached from git's worktree
      // registry already (manual rm, daemon crash, etc). Best-effort rm + prune.
      await run(["rm", "-rf", c.worktreePath]);
      await run(["git", "worktree", "prune"], { cwd: c.projectWorkdir });
      if (!existsSync(c.worktreePath)) {
        removed++;
        worktreeGone = true;
      } else {
        failed++;
        process.stderr.write(`factory: failed to remove ${c.worktreePath}: ${wr.stderr.trim()}\n`);
      }
    }
    // Only delete the branch once its worktree is gone (a checked-out branch
    // cannot be deleted) and only when it's safe to lose from the ref.
    if (worktreeGone && c.branchDeletable) {
      const br = await run(["git", "branch", "-D", c.branch], { cwd: c.projectWorkdir });
      if (br.exitCode === 0) branchesDeleted++;
      else
        process.stderr.write(`factory: failed to delete branch ${c.branch}: ${br.stderr.trim()}\n`);
    }
  }

  let logsRemoved = 0;
  for (const c of logCandidates) {
    await run(["rm", "-rf", c.logDir]);
    if (!existsSync(c.logDir)) logsRemoved++;
    else process.stderr.write(`factory: failed to remove log dir ${c.logDir}\n`);
  }

  process.stdout.write(`\nremoved: ${removed} worktrees`);
  if (branchesDeleted > 0) process.stdout.write(` · ${branchesDeleted} branch refs`);
  if (logsRemoved > 0) process.stdout.write(` · ${logsRemoved} log dirs`);
  if (failed > 0) process.stdout.write(` · failed: ${failed}`);
  process.stdout.write("\n");
  return failed > 0 ? 1 : 0;
}
