import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";

import { parsePruneArgs, runPrune } from "../src/commands/prune.ts";

const DAY_MS = 86_400_000;

let root: string;
let home: string;
let workdir: string;
let db: Database;

async function git(args: string[], cwd: string): Promise<string> {
  const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.email", "t@t.t"], dir);
  await git(["config", "user.name", "t"], dir);
  await Bun.write(path.join(dir, ".keep"), "");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "init"], dir);
}

function insertRun(row: {
  id: string;
  status: string;
  branch: string;
  worktreePath: string;
  endedAt: number | null;
}): void {
  db.prepare(
    "INSERT INTO runs (id, project_id, status, branch, worktree_path, ended_at) VALUES (?, 'p1', ?, ?, ?, ?)",
  ).run(row.id, row.status, row.branch, row.worktreePath, row.endedAt);
}

/** Create a worktree on a fresh `factory/run-<id>` branch; optionally add a commit. */
async function makeRunWorktree(id: string, opts: { commit: boolean }): Promise<string> {
  const branch = `factory/run-${id}`;
  const wt = path.join(root, `wt-${id}`);
  await git(["worktree", "add", "-b", branch, wt, "main"], workdir);
  if (opts.commit) {
    await Bun.write(path.join(wt, `${id}.txt`), id);
    await git(["add", "-A"], wt);
    await git(["commit", "-q", "-m", `work ${id}`], wt);
  }
  return wt;
}

function makeLogDir(id: string): string {
  const dir = path.join(workdir, ".factory", "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test-only stdout shim
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }) as any;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "factory-prune-"));
  home = path.join(root, "home");
  workdir = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  process.env.FACTORY_HOME = home;

  db = new Database(path.join(home, "data.db"));
  db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, workdir_path TEXT)");
  db.run(
    "CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, branch TEXT, worktree_path TEXT, ended_at INTEGER)",
  );
  db.prepare("INSERT INTO projects (id, slug, workdir_path) VALUES ('p1', 'proj', ?)").run(workdir);

  await initRepo(workdir);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.FACTORY_HOME;
});

describe("factory prune — branch refs", () => {
  test("--apply deletes merged + empty branches, keeps unmerged failed branch", async () => {
    const now = Date.now();

    // A: completed, merged to main → safe to delete.
    const wtA = await makeRunWorktree("A", { commit: true });
    await git(["merge", "--no-ff", "-m", "merge A", "factory/run-A"], workdir);
    insertRun({
      id: "A",
      status: "completed",
      branch: "factory/run-A",
      worktreePath: wtA,
      endedAt: now,
    });

    // C: completed, zero commits beyond base → safe to delete.
    const wtC = await makeRunWorktree("C", { commit: false });
    insertRun({
      id: "C",
      status: "completed",
      branch: "factory/run-C",
      worktreePath: wtC,
      endedAt: now,
    });

    // B: failed, unmerged commit → NOT safe (retry/salvage substrate).
    const wtB = await makeRunWorktree("B", { commit: true });
    insertRun({
      id: "B",
      status: "failed",
      branch: "factory/run-B",
      worktreePath: wtB,
      endedAt: now,
    });

    const code = await runPrune(parsePruneArgs(["--apply", "--include-failed"]));
    expect(code).toBe(0);

    const branches = await git(["branch", "--list"], workdir);
    expect(branches).not.toContain("factory/run-A");
    expect(branches).not.toContain("factory/run-C");
    expect(branches).toContain("factory/run-B"); // kept: unmerged work

    // Worktrees are all reclaimed regardless of branch fate.
    expect(existsSync(wtA)).toBe(false);
    expect(existsSync(wtB)).toBe(false);
    expect(existsSync(wtC)).toBe(false);
  });

  test("dry-run reports deletable vs kept branches without mutating", async () => {
    const now = Date.now();
    const wtA = await makeRunWorktree("A", { commit: true });
    await git(["merge", "--no-ff", "-m", "merge A", "factory/run-A"], workdir);
    insertRun({
      id: "A",
      status: "completed",
      branch: "factory/run-A",
      worktreePath: wtA,
      endedAt: now,
    });

    const wtB = await makeRunWorktree("B", { commit: true });
    insertRun({
      id: "B",
      status: "failed",
      branch: "factory/run-B",
      worktreePath: wtB,
      endedAt: now,
    });

    const out = await captureStdout(() => runPrune(parsePruneArgs(["--include-failed"])));

    expect(out).toContain("branch:del");
    expect(out).toContain("branch:keep");
    expect(out).toContain("1 branch refs"); // only A is deletable

    // Nothing removed in dry-run.
    const branches = await git(["branch", "--list"], workdir);
    expect(branches).toContain("factory/run-A");
    expect(branches).toContain("factory/run-B");
    expect(existsSync(wtA)).toBe(true);
    expect(existsSync(wtB)).toBe(true);
  });
});

describe("factory prune — log dirs", () => {
  test("--apply sweeps old terminal log dirs, never a running run's log dir", async () => {
    const now = Date.now();

    // D: completed 40d ago → swept (older than 30d default). Log-only (no worktree).
    const logD = makeLogDir("D");
    await Bun.write(path.join(logD, "log.txt"), "x".repeat(64));
    insertRun({
      id: "D",
      status: "completed",
      branch: "factory/run-D",
      worktreePath: "",
      endedAt: now - 40 * DAY_MS,
    });

    // E: running, ancient ended_at, but running runs are NEVER swept regardless of age.
    const logE = makeLogDir("E");
    await Bun.write(path.join(logE, "log.txt"), "x".repeat(64));
    insertRun({
      id: "E",
      status: "running",
      branch: "factory/run-E",
      worktreePath: "",
      endedAt: now - 90 * DAY_MS,
    });

    // G: completed but recent (10d) → kept, below the 30d threshold.
    const logG = makeLogDir("G");
    await Bun.write(path.join(logG, "log.txt"), "x".repeat(64));
    insertRun({
      id: "G",
      status: "completed",
      branch: "factory/run-G",
      worktreePath: "",
      endedAt: now - 10 * DAY_MS,
    });

    const code = await runPrune(parsePruneArgs(["--apply"]));
    expect(code).toBe(0);

    expect(existsSync(logD)).toBe(false); // swept
    expect(existsSync(logE)).toBe(true); // running — protected
    expect(existsSync(logG)).toBe(true); // too recent
  });

  test("blocked log dirs are protected even with --include-failed", async () => {
    const now = Date.now();
    const logF = makeLogDir("F");
    await Bun.write(path.join(logF, "log.txt"), "x".repeat(64));
    insertRun({
      id: "F",
      status: "blocked",
      branch: "factory/run-F",
      worktreePath: "",
      endedAt: now - 60 * DAY_MS,
    });

    const code = await runPrune(parsePruneArgs(["--apply", "--include-failed"]));
    expect(code).toBe(0);
    expect(existsSync(logF)).toBe(true); // reaper salvage substrate — never swept
  });

  test("dry-run lists stale log dirs with a count", async () => {
    const now = Date.now();
    const logD = makeLogDir("D");
    await Bun.write(path.join(logD, "log.txt"), "x".repeat(64));
    insertRun({
      id: "D",
      status: "completed",
      branch: "factory/run-D",
      worktreePath: "",
      endedAt: now - 40 * DAY_MS,
    });

    const out = await captureStdout(() => runPrune(parsePruneArgs([])));
    expect(out).toContain("stale log dirs (older than 30d)");
    expect(out).toContain("1 log dirs");
    expect(existsSync(logD)).toBe(true); // dry-run mutates nothing
  });
});
