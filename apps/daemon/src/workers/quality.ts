import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import YAML from "yaml";

const STDOUT_TAIL_BYTES = 4 * 1024;

/**
 * One quality check declared in `<project>/.factory/quality.yaml`. Commands
 * run in the run's worktree (or `cwd` relative to it for monorepos), with
 * stdout/stderr captured. Failures are informational in v0.2.
 */
export interface QualityCheck {
  name: string;
  command: string;
  /** Defaults to "." (the worktree root). Useful for monorepo workspaces. */
  cwd?: string;
  /** Per-check wall-clock cap. Defaults to 300s. */
  timeoutSeconds?: number;
}

export interface QualityCheckResult {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export interface QualityReport {
  ranAt: number;
  results: QualityCheckResult[];
  /** "skipped" when no checks were configured; "fail" when any check failed. */
  overall: "pass" | "fail" | "skipped";
}

interface QualityYaml {
  checks?: Array<{
    name?: unknown;
    command?: unknown;
    cwd?: unknown;
    timeoutSeconds?: unknown;
  }>;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Read and validate a project's quality.yaml. Returns null when the file is
 * missing — the runner treats that as "no quality checks for this project."
 * Throws on malformed YAML or invalid entries; the caller surfaces this in
 * the run summary rather than silently skipping.
 */
export async function loadQualityConfig(configPath: string): Promise<QualityCheck[] | null> {
  if (!existsSync(configPath)) return null;
  const raw = await readFile(configPath, "utf8");
  let parsed: QualityYaml;
  try {
    parsed = (YAML.parse(raw) ?? {}) as QualityYaml;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`quality.yaml parse failed: ${message}`);
  }
  if (!Array.isArray(parsed.checks)) return [];
  const out: QualityCheck[] = [];
  for (const c of parsed.checks) {
    if (!c || typeof c !== "object") continue;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const command = typeof c.command === "string" ? c.command.trim() : "";
    if (!name || !command) {
      throw new Error("quality.yaml: every check needs name + command");
    }
    out.push({
      name,
      command,
      cwd: typeof c.cwd === "string" && c.cwd.length > 0 ? c.cwd : undefined,
      timeoutSeconds:
        typeof c.timeoutSeconds === "number" && c.timeoutSeconds > 0 ? c.timeoutSeconds : undefined,
    });
  }
  return out;
}

function tailBytes(buf: string, max: number): string {
  if (buf.length <= max) return buf;
  return `…(truncated)…\n${buf.slice(-max)}`;
}

async function runOne(check: QualityCheck, worktreePath: string): Promise<QualityCheckResult> {
  const cwd = check.cwd ? path.join(worktreePath, check.cwd) : worktreePath;
  const timeoutMs = (check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const startedAt = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  // Use shell so users can write `bun run typecheck`, `cd packages/x && cargo
  // test`, etc. Quality checks are operator-controlled — they're already
  // running arbitrary commands, the shell is the obvious interface.
  const proc = bunSpawn({
    cmd: ["sh", "-lc", check.command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" }, // CI=1 to suppress interactive prompts
    signal: ac.signal,
  });

  let exitCode = 0;
  let stdoutText = "";
  let stderrText = "";
  try {
    const [stdoutResp, stderrResp] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    stdoutText = stdoutResp;
    stderrText = stderrResp;
    exitCode = await proc.exited;
  } catch (err) {
    stderrText = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  } finally {
    clearTimeout(timer);
  }

  return {
    name: check.name,
    command: check.command,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: tailBytes(stdoutText, STDOUT_TAIL_BYTES),
    stderrTail: tailBytes(stderrText, STDOUT_TAIL_BYTES),
    timedOut,
  };
}

export interface RunQualityChecksOpts {
  worktreePath: string;
  /** Path to `<project>/.factory/quality.yaml`. */
  configPath: string;
}

/**
 * Run all checks declared in the project's quality.yaml, sequentially.
 * Sequential execution keeps memory bounded when test suites and lint runs
 * are heavy; running them in parallel buys little because most projects'
 * configs are < 4 checks anyway.
 *
 * Returns a `QualityReport` always — even on missing config (overall:
 * skipped) — so the runner can persist a single shape regardless.
 */
export async function runQualityChecks(opts: RunQualityChecksOpts): Promise<QualityReport> {
  const checks = await loadQualityConfig(opts.configPath);
  const ranAt = Date.now();
  if (checks === null || checks.length === 0) {
    return { ranAt, results: [], overall: "skipped" };
  }

  const results: QualityCheckResult[] = [];
  for (const c of checks) {
    const r = await runOne(c, opts.worktreePath);
    results.push(r);
  }
  const anyFail = results.some((r) => r.exitCode !== 0 || r.timedOut);
  return { ranAt, results, overall: anyFail ? "fail" : "pass" };
}
