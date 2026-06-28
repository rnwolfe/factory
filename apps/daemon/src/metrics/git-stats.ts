import { spawn as bunSpawn } from "bun";

/**
 * Per-day git stats for a project workdir (ADR-013): commits + LOC shipped on the
 * canonical branch in a [start, end) window. `--no-merges` so the `--no-ff` merge
 * commits Factory creates don't double-count — the underlying work commits carry
 * the diffs. Counts what LANDED (shipped value, not churn). Returns null when the
 * path isn't a git repo or git fails (a missing project never breaks a rollup).
 */
export interface GitDayStats {
  commits: number;
  locAdded: number;
  locRemoved: number;
}

export async function gitDayStats(
  workdir: string,
  dayStartMs: number,
  dayEndMs: number,
): Promise<GitDayStats | null> {
  // Strip milliseconds; git's --since/--until date parser is happiest with plain ISO.
  const since = new Date(dayStartMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const until = new Date(dayEndMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    const proc = bunSpawn({
      cmd: [
        "git",
        "-C",
        workdir,
        "log",
        "--no-merges",
        `--since=${since}`,
        `--until=${until}`,
        "--numstat",
        "--format=%H", // one full commit hash per commit (a bare word is parsed as a named format)
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return parseNumstat(out);
  } catch {
    return null;
  }
}

export function parseNumstat(out: string): GitDayStats {
  let commits = 0;
  let locAdded = 0;
  let locRemoved = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // A commit-hash line (from --format=%H): all hex, no tab.
    if (!line.includes("\t") && /^[0-9a-f]{7,64}$/i.test(line.trim())) {
      commits++;
      continue;
    }
    // numstat: "<added>\t<removed>\t<path>"; binary files use "-".
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "", 10);
    const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "", 10);
    if (Number.isFinite(added)) locAdded += added;
    if (Number.isFinite(removed)) locRemoved += removed;
  }
  return { commits, locAdded, locRemoved };
}
