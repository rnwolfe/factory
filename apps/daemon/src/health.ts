import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";

export interface HealthInfo {
  status: "ok" | "degraded";
  version: string;
  uptime_ms: number;
  active_runs: number;
  active_sessions: number;
}

const STARTED_AT = Date.now();

/**
 * Build the /health response. Reads version from FACTORY_VERSION (set by
 * `factory upgrade` post-checkout) or falls back to the packaged
 * `package.json` version. Counts active runs/sessions via cheap aggregate
 * queries — the expectation is /health is hit on liveness probes, so it
 * has to stay sub-50ms even on a busy daemon.
 */
export async function buildHealth(db: Db): Promise<HealthInfo> {
  let activeRuns = 0;
  let activeSessions = 0;
  let status: HealthInfo["status"] = "ok";
  try {
    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.status, "running"))
      .all();
    activeRuns = runs.length;
    const sessions = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.status, "running"))
      .all();
    activeSessions = sessions.length;
  } catch {
    status = "degraded";
  }
  return {
    status,
    version: resolveVersion(),
    uptime_ms: Date.now() - STARTED_AT,
    active_runs: activeRuns,
    active_sessions: activeSessions,
  };
}

let cachedVersion: string | null = null;

/**
 * Resolve the running daemon's version. Order of precedence:
 *   1. FACTORY_VERSION env var (set by `factory upgrade` if it wants to pin
 *      a specific tag in the response — useful when the checkout is detached
 *      at a tagged sha and you want the tag, not the sha7).
 *   2. `git describe --tags --always --dirty` in the daemon's cwd. Falls
 *      back to a sha7 when no tag exists.
 *   3. Literal "dev".
 *
 * Cached for the daemon's lifetime — version doesn't change without a
 * restart. Synchronous spawn at first call is acceptable; /health is only
 * hit a handful of times per minute.
 */
function resolveVersion(): string {
  if (process.env.FACTORY_VERSION) return process.env.FACTORY_VERSION;
  if (cachedVersion !== null) return cachedVersion;
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "describe", "--tags", "--always", "--dirty"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      cachedVersion = proc.stdout.toString().trim() || "dev";
    } else {
      cachedVersion = "dev";
    }
  } catch {
    cachedVersion = "dev";
  }
  return cachedVersion;
}
