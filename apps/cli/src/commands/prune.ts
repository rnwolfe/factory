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
  help: boolean;
}

const PRUNE_HELP = `factory prune — clean up worktrees from terminal runs

usage:
  factory prune [options]

options:
  --apply              actually remove worktrees (default: dry-run preview)
  --include-failed     also clean failed/blocked/aborted/usage_capped/deferred
                       run worktrees (default: only completed runs)
  --project=<slug>     limit to a single project
  --age=<days>         only clean worktrees older than N days
  --help, -h           this message

Only the worktree directory is removed; the run's branch ref stays so
\`git log <branch>\` still works for inspection. Runs with status
running/queued are never touched (the query filter excludes them).
`;

export function parsePruneArgs(argv: string[]): PruneArgs {
  let apply = false;
  let includeFailed = false;
  let project: string | null = null;
  let ageDays = 0;
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
  }
  return { apply, includeFailed, project, ageDays, help };
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
  worktree_path: string;
  ended_at: number | null;
  slug: string;
  workdir_path: string;
}

interface Candidate {
  runId: string;
  status: string;
  worktreePath: string;
  projectSlug: string;
  projectWorkdir: string;
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
      SELECT r.id, r.status, r.worktree_path, r.ended_at,
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
        worktreePath: r.worktree_path,
        projectSlug: r.slug,
        projectWorkdir: r.workdir_path,
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

  // Size computation in parallel — bounded by candidate count, which is
  // small (tens, not thousands) and du is fast on per-run worktrees.
  await Promise.all(
    candidates.map(async (c) => {
      c.sizeBytes = await dirSizeBytes(c.worktreePath);
    }),
  );

  const byProject = groupBy(candidates, (c) => c.projectSlug);

  process.stdout.write(`factory prune (${args.apply ? "apply" : "dry-run"}):\n`);
  if (candidates.length === 0) {
    process.stdout.write("\nnothing to clean. ");
    if (!args.includeFailed) {
      process.stdout.write("add --include-failed to also consider failed/blocked/aborted runs.\n");
    } else {
      process.stdout.write("no terminal-status worktrees exist on disk.\n");
    }
    return 0;
  }

  let totalBytes = 0;
  for (const [slug, list] of byProject) {
    process.stdout.write(`\n  ${slug}:\n`);
    for (const c of list) {
      const size = formatBytes(c.sizeBytes).padStart(7);
      const age = ageOf(c.endedAt).padStart(4);
      process.stdout.write(`    ${c.runId.slice(0, 12)} [${c.status.padEnd(12)}] ${size} ${age}\n`);
      totalBytes += c.sizeBytes;
    }
  }

  const verb = args.apply ? "removing" : "would remove";
  process.stdout.write(`\n${verb}: ${candidates.length} worktrees · ${formatBytes(totalBytes)}\n`);

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
  for (const c of candidates) {
    const wr = await run(["git", "worktree", "remove", "--force", c.worktreePath], {
      cwd: c.projectWorkdir,
    });
    if (wr.exitCode === 0) {
      removed++;
      continue;
    }
    // Filesystem fallback: directory might be detached from git's worktree
    // registry already (manual rm, daemon crash, etc). Best-effort rm + prune.
    await run(["rm", "-rf", c.worktreePath]);
    await run(["git", "worktree", "prune"], { cwd: c.projectWorkdir });
    if (!existsSync(c.worktreePath)) {
      removed++;
    } else {
      failed++;
      process.stderr.write(`factory: failed to remove ${c.worktreePath}: ${wr.stderr.trim()}\n`);
    }
  }

  process.stdout.write(`\nremoved: ${removed}`);
  if (failed > 0) process.stdout.write(` · failed: ${failed}`);
  process.stdout.write("\n");
  return failed > 0 ? 1 : 0;
}
