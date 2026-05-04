import { readFile } from "node:fs/promises";
import path from "node:path";
import { schema } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { eq, inArray } from "drizzle-orm";
import { parseFactoryStatus } from "./factory-status.ts";
import { resumeOrphanedRun, type SubmitRunDeps } from "./submit.ts";

/**
 * Best-effort tmux kill. Failure is fine — the session may already be gone,
 * tmux may not be running, or we may not own the session.
 */
async function killTmuxSession(name: string): Promise<void> {
  try {
    const proc = bunSpawn({
      cmd: ["tmux", "kill-session", "-t", name],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {
    // ignore
  }
}

export function tmuxSessionNameFor(slug: string, runId: string): string {
  return `factory-${slug}-${runId}`.slice(0, 60);
}

/**
 * Read the agent's persisted log for an orphaned run and try to extract its
 * `factory-status` declaration. The log lives at
 * `<workdirPath>/.factory/runs/<runId>/log.txt` (see runner.ts logSocketPath).
 * Streaming-JSON `assistant` messages embed text deltas; we concatenate all
 * such text and run the standard parser over it.
 *
 * Returns null if the log doesn't exist, no text was found, or no status
 * block was emitted.
 */
async function recoverFactoryStatusFromLog(
  workdirPath: string,
  runId: string,
): Promise<{ status: "completed" | "blocked" | "failed"; summary: string } | null> {
  const logPath = path.join(workdirPath, ".factory", "runs", runId, "log.txt");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return null;
  }
  if (raw.length === 0) return null;

  // Walk newline-delimited stream-json. Pull text deltas out of `assistant`
  // and `result` shapes. Tolerate non-JSON lines (the log is shared with raw
  // pane bytes via pipe-pane).
  let text = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        result?: string;
      };
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const c of parsed.message.content) {
          if (c.type === "text" && typeof c.text === "string") text += c.text;
        }
      } else if (parsed.type === "result" && typeof parsed.result === "string") {
        text += parsed.result;
      }
    } catch {
      // skip
    }
  }
  if (text.length === 0) return null;

  const parsed = parseFactoryStatus(text);
  if (!parsed) return null;
  const map = { done: "completed", blocked: "blocked", failed: "failed" } as const;
  return { status: map[parsed.status], summary: parsed.summary };
}

export interface ReapStats {
  /** Agent had emitted a final factory-status block; row updated from log. */
  recovered: number;
  /** Re-submitted to claude with --resume <sessionId> to continue the work. */
  resumed: number;
  /** No salvage path; row marked aborted. */
  aborted: number;
}

/**
 * Reconcile any `running` / `queued` runs left over from a prior daemon
 * process. Their AbortControllers are gone; the runtime cannot recover them.
 *
 * Three-tier salvage, in preference order:
 *  1. **Recover from log.** Read the agent's persisted stream-json and try
 *     to extract its final `factory-status` declaration. If the agent
 *     finished cleanly before the daemon died, we mark the row with the
 *     declared status (no re-spawn needed).
 *  2. **Resume the session.** If the run row carries a `sessionId`, kill any
 *     leftover tmux session and re-submit the run with `--resume <sessionId>`
 *     plus a continuation prompt. The agent picks up where it left off
 *     instead of starting over from scratch.
 *  3. **Mark aborted.** Only if neither of the above is possible (no log,
 *     no sessionId — i.e. the daemon died before claude even initialized).
 *
 * Called once at daemon startup. Without this, restarting the daemon (or
 * `bun --watch` auto-restarting on a file save) silently throws away
 * in-flight work.
 */
export async function reapOrphanedRuns(deps: SubmitRunDeps): Promise<ReapStats> {
  const { db } = deps;
  const orphans = await db
    .select({
      id: schema.runs.id,
      sessionId: schema.runs.sessionId,
      slug: schema.projects.slug,
      workdirPath: schema.projects.workdirPath,
    })
    .from(schema.runs)
    .innerJoin(schema.projects, eq(schema.runs.projectId, schema.projects.id))
    .where(inArray(schema.runs.status, ["running", "queued"]))
    .all();

  const stats: ReapStats = { recovered: 0, resumed: 0, aborted: 0 };
  if (orphans.length === 0) return stats;

  const now = Date.now();
  for (const o of orphans) {
    // The tmux session is dead either way — no daemon process is reading
    // its output. Kill it before we move on.
    await killTmuxSession(tmuxSessionNameFor(o.slug, o.id));

    // Tier 1: agent already declared a status before the daemon died.
    const recovered = await recoverFactoryStatusFromLog(o.workdirPath, o.id);
    if (recovered) {
      await db
        .update(schema.runs)
        .set({
          status: recovered.status,
          endedAt: now,
          summary: recovered.summary,
        })
        .where(eq(schema.runs.id, o.id));
      stats.recovered += 1;
      continue;
    }

    // Tier 2: claude session exists; resume the conversation rather than
    // starting from scratch.
    if (o.sessionId) {
      try {
        await resumeOrphanedRun(deps, o.id);
        stats.resumed += 1;
        continue;
      } catch (err) {
        // Fall through to abort. Resume can fail e.g. if the pool refuses
        // submissions or the row was just deleted out from under us.
        console.warn(
          `[reap] resume failed for ${o.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Tier 3: nothing to salvage.
    await db
      .update(schema.runs)
      .set({
        status: "aborted",
        endedAt: now,
        summary: "Run orphaned by a daemon restart with no recoverable state.",
      })
      .where(eq(schema.runs.id, o.id));
    stats.aborted += 1;
  }
  return stats;
}
