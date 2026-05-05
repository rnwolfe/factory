import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { eq, inArray } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Project slug (the parent directory under worktreesRoot). */
  projectSlug: string;
  /** Run id (the worktree directory name). */
  runId: string;
  /** Branch checked out in the worktree, or null if detached. */
  branch: string | null;
  /** Total directory size in bytes, recursive. */
  sizeBytes: number;
  /** Last modification time of the worktree directory. */
  mtime: number;
  /** True when no run row exists for this runId. */
  orphaned: boolean;
  /** True when an associated run row has status='running' or 'queued'. */
  active: boolean;
  /**
   * The associated project's id, when we could match the slug to a row.
   * Useful for deep-linking from the row.
   */
  projectId: string | null;
  /** Run row status, if a row exists. */
  runStatus: string | null;
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

/** Recursive directory size in bytes. Skips symlinks to avoid loops. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const p = path.join(dir, entry);
      try {
        const s = await stat(p);
        if (s.isSymbolicLink()) return;
        if (s.isDirectory()) {
          total += await dirSize(p);
        } else if (s.isFile()) {
          total += s.size;
        }
      } catch {
        // unreadable — skip
      }
    }),
  );
  return total;
}

async function readBranch(worktreePath: string): Promise<string | null> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  if (r.exitCode !== 0) return null;
  const trimmed = r.stdout.trim();
  if (!trimmed || trimmed === "HEAD") return null;
  return trimmed;
}

/**
 * Walk `<worktreesRoot>/<slug>/<runId>/` and return one entry per worktree.
 *
 * Sort order: largest first, so the operator's eyes land on the worst
 * offenders. The PWA preserves this order.
 */
export async function listWorktrees(config: FactoryConfig, db: Db): Promise<WorktreeInfo[]> {
  const root = config.worktreesRoot;
  if (!existsSync(root)) return [];

  let slugs: string[];
  try {
    slugs = await readdir(root);
  } catch {
    return [];
  }

  // Index project rows by slug so we can resolve projectId from the
  // worktree's parent directory name.
  const projects = await db.select().from(schema.projects).all();
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));

  const out: WorktreeInfo[] = [];
  for (const slug of slugs) {
    const slugDir = path.join(root, slug);
    let entries: string[];
    try {
      const s = await stat(slugDir);
      if (!s.isDirectory()) continue;
      entries = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const runId of entries) {
      const wtPath = path.join(slugDir, runId);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(wtPath);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      const [size, branch] = await Promise.all([dirSize(wtPath), readBranch(wtPath)]);
      out.push({
        path: wtPath,
        projectSlug: slug,
        runId,
        branch,
        sizeBytes: size,
        mtime: s.mtimeMs,
        orphaned: true, // resolved in the next pass
        active: false,
        projectId: projectBySlug.get(slug)?.id ?? null,
        runStatus: null,
      });
    }
  }

  if (out.length === 0) return out;

  // One DB query for all run ids — annotate orphaned/active in place.
  const runIds = out.map((w) => w.runId);
  const runRows = await db
    .select({
      id: schema.runs.id,
      status: schema.runs.status,
    })
    .from(schema.runs)
    .where(inArray(schema.runs.id, runIds))
    .all();
  const runById = new Map(runRows.map((r) => [r.id, r]));
  for (const w of out) {
    const row = runById.get(w.runId);
    if (row) {
      w.orphaned = false;
      w.runStatus = row.status;
      w.active = row.status === "running" || row.status === "queued";
    }
  }

  out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return out;
}

export interface RemoveResult {
  ok: boolean;
  /** When false, this is the operator-actionable reason. */
  reason?: string;
}

/**
 * Remove a worktree at `wtPath`. Tries `git worktree remove --force` against
 * the parent project repo first (so the project's `.git/worktrees/` pointer
 * is cleaned up), then falls back to `rm -rf` if the directory survives.
 *
 * Guards against accidentally removing a worktree of a `running`/`queued`
 * run, or any path outside `config.worktreesRoot`.
 */
export async function removeWorktreeAt(
  config: FactoryConfig,
  db: Db,
  wtPath: string,
): Promise<RemoveResult> {
  const resolved = path.resolve(wtPath);
  const root = path.resolve(config.worktreesRoot);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false, reason: "path is not under the configured worktrees root" };
  }
  if (!existsSync(resolved)) {
    return { ok: false, reason: "worktree path does not exist" };
  }

  // Decompose <root>/<slug>/<runId> so we can guard against active runs.
  const rel = path.relative(root, resolved);
  const parts = rel.split(path.sep);
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: "path is not in <slug>/<runId> form under worktrees root",
    };
  }
  const [slug, runId] = parts;
  if (!slug || !runId) {
    return { ok: false, reason: "could not derive slug/runId from path" };
  }

  const runRow = await db
    .select({ id: schema.runs.id, status: schema.runs.status, projectId: schema.runs.projectId })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .get();

  if (runRow && (runRow.status === "running" || runRow.status === "queued")) {
    return {
      ok: false,
      reason: `run ${runId} is ${runRow.status} — abort it before deleting its worktree`,
    };
  }

  // Resolve the parent project repo so `git worktree remove` can drop the
  // .git/worktrees/<runId> pointer. Best-effort — if the project row is
  // missing (orphaned worktree), skip straight to rm -rf.
  let projectWorkdir: string | null = null;
  if (runRow?.projectId) {
    const project = await db
      .select({ workdirPath: schema.projects.workdirPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, runRow.projectId))
      .get();
    projectWorkdir = project?.workdirPath ?? null;
  } else {
    const project = await db
      .select({ workdirPath: schema.projects.workdirPath })
      .from(schema.projects)
      .where(eq(schema.projects.slug, slug))
      .get();
    projectWorkdir = project?.workdirPath ?? null;
  }

  if (projectWorkdir && existsSync(projectWorkdir)) {
    await git(["worktree", "remove", "--force", resolved], projectWorkdir);
    // best-effort prune so .git/worktrees doesn't leak admin dirs
    await git(["worktree", "prune"], projectWorkdir);
  }

  if (existsSync(resolved)) {
    await rm(resolved, { recursive: true, force: true });
  }

  return { ok: true };
}
