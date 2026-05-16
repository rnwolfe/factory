import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Db, type DeferredTaskStatus, schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq, inArray } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { FactoryDefer } from "../workers/factory-status.ts";
import type { WorkerPool } from "../workers/pool.ts";
import type { RunRegistry } from "../workers/registry.ts";
import { submitRun } from "../workers/submit.ts";

/**
 * Bridges work that exceeds a single `claude --print` turn — long
 * builds, multi-stage indexing, exhaustive test runs.
 *
 * Lifecycle:
 *   1. Agent emits a `factory-defer` block alongside the run's normal
 *      output. Runner parses it, calls `spawnDeferredTask`.
 *   2. We spawn the command as a child of the daemon (NOT the agent's
 *      tmux — that pty closes when claude --print exits, taking
 *      anything still attached with it). Stdout+stderr are captured
 *      to a log file inside the run's worktree.
 *   3. The source run row's status is set to `deferred`. No auto-merge,
 *      no quality checks, no auto-advance — the run is logically still
 *      in flight.
 *   4. When the subprocess exits, `onDeferredCompletion` records the
 *      exit code, auto-commits any newly-produced gitignored→tracked
 *      state on the source's branch, and submits a continuation run
 *      that REUSES the source's worktree (so the build's gitignored
 *      output is right where the resumed agent expects it).
 *   5. The continuation run starts on the same worktree + branch with
 *      the agent's `continuation` text + a structured outcome block
 *      as its operatorContext preamble.
 *
 * Why not interject into harness lifecycle? Because the harness's
 * `Monitor` / `ScheduleWakeup` / `Bash &` patterns assume an interactive
 * harness that survives between turns. `claude --print` doesn't. This is
 * Factory's bridge for that gap, not a replacement for harness tooling.
 */

const LOG_TAIL_BYTES = 4 * 1024;

export interface DeferredOrchestrateDeps {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
}

interface RunRow {
  id: string;
  projectId: string;
  taskId: string | null;
  worktreePath: string;
  branch: string;
}

/**
 * Spawn the deferred command as a daemon-child subprocess. Inserts the
 * `deferred_tasks` row, kicks the process off detached so daemon child-
 * reaping doesn't block on it, and registers a fire-and-forget
 * completion handler that submits the continuation run.
 *
 * Returns the deferred-task id so the runner can stamp it on the source
 * run row's summary for visibility.
 */
export async function spawnDeferredTask(
  deps: DeferredOrchestrateDeps,
  source: RunRow,
  defer: FactoryDefer,
): Promise<{ deferredTaskId: string; logPath: string }> {
  const { db, events } = deps;

  const deferredTaskId = createId();
  // Log lives inside the worktree's .factory/runs/<runId>/ directory so
  // the operator (and any future agent revisiting this checkout) can find
  // it via the same path the run's normal log lives at.
  const logDir = path.join(source.worktreePath, ".factory", "runs", source.id);
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "deferred.log");

  // Open in append mode via shell redirection. We don't open the FD here
  // because Bun.spawn wants Bun.file or a stream; redirection in `sh -c`
  // is the cleanest way to get tee-like combined stdout+stderr capture.
  const wrapped = `${defer.command} >> ${shellQuote(logPath)} 2>&1`;
  const proc = bunSpawn({
    cmd: ["sh", "-c", wrapped],
    cwd: source.worktreePath,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    // No `detached` — Bun spawns children in a process group anyway, and
    // we want them to die with the daemon if the daemon goes away. Cross-
    // restart resilience comes from the boot reaper, which checks pid
    // liveness.
  });

  const startedAt = Date.now();
  await db.insert(schema.deferredTasks).values({
    id: deferredTaskId,
    runId: source.id,
    projectId: source.projectId,
    command: defer.command,
    summary: defer.summary,
    continuationPrompt: defer.continuation,
    logPath,
    status: "running",
    pid: proc.pid ?? null,
    startedAt,
  });

  events.publish({
    channel: "events",
    kind: "deferred_task_started",
    runId: source.id,
    projectId: source.projectId,
    deferredTaskId,
    summary: defer.summary,
  });

  // Fire-and-forget completion handler. Bun's `proc.exited` resolves
  // even after we return, and any exception in here is logged + the
  // task row is marked failed so the operator notices.
  void (async () => {
    try {
      const exitCode = await proc.exited;
      await onDeferredCompletion(deps, deferredTaskId, exitCode);
    } catch (err) {
      console.error(
        `[deferred] completion handler crashed for ${deferredTaskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await db
        .update(schema.deferredTasks)
        .set({
          status: "failed",
          endedAt: Date.now(),
          exitCode: -1,
        })
        .where(eq(schema.deferredTasks.id, deferredTaskId));
    }
  })();

  return { deferredTaskId, logPath };
}

async function onDeferredCompletion(
  deps: DeferredOrchestrateDeps,
  deferredTaskId: string,
  exitCode: number,
): Promise<void> {
  const { config, db, events } = deps;

  const task = await db
    .select()
    .from(schema.deferredTasks)
    .where(eq(schema.deferredTasks.id, deferredTaskId))
    .get();
  if (!task) return; // row vanished — nothing to do

  const source = await db.select().from(schema.runs).where(eq(schema.runs.id, task.runId)).get();
  if (!source) {
    await db
      .update(schema.deferredTasks)
      .set({ status: "failed", endedAt: Date.now(), exitCode })
      .where(eq(schema.deferredTasks.id, deferredTaskId));
    return;
  }

  // Cancellation overrides the natural exit — operator already requested
  // we abandon this; don't submit a continuation.
  if (task.status === "cancelled") {
    await db
      .update(schema.deferredTasks)
      .set({ endedAt: Date.now(), exitCode })
      .where(eq(schema.deferredTasks.id, deferredTaskId));
    return;
  }

  const finalStatus: (typeof schema.deferredTaskStatusEnum)[number] =
    exitCode === 0 ? "completed" : "failed";

  await db
    .update(schema.deferredTasks)
    .set({ status: finalStatus, endedAt: Date.now(), exitCode })
    .where(eq(schema.deferredTasks.id, deferredTaskId));

  // Auto-commit anything the deferred command produced that's now tracked
  // (file moved out of .gitignore, new tracked file, etc.) so the
  // continuation run sees a clean tree. Mirrors runner.ts post-spawn.
  try {
    await commitAllChanges(
      source.worktreePath,
      `chore: auto-commit deferred task ${deferredTaskId.slice(0, 8)}`,
      config.gitAuthor,
    );
  } catch {
    // ignore — continuation will note the dirty state if the agent cares.
  }

  // Build the continuation operatorContext: the agent's own continuation
  // text + an outcome block. The agent's `continuation` is its
  // note-to-future-self; we add the structural outcome (exit code, log
  // tail, log path) so the resumed agent can decide what to do.
  const tail = await readLogTail(task.logPath, LOG_TAIL_BYTES);
  const continuationContext = renderContinuationContext({
    summary: task.summary,
    continuation: task.continuationPrompt,
    command: task.command,
    exitCode,
    logPath: task.logPath,
    tail,
    finalStatus,
  });

  const result = await submitRun(deps, {
    projectId: source.projectId,
    taskId: source.taskId ?? undefined,
    operatorContext: continuationContext,
    reuseFromRunId: source.id,
  });

  await db
    .update(schema.deferredTasks)
    .set({ continuationRunId: result.runId })
    .where(eq(schema.deferredTasks.id, deferredTaskId));

  events.publish({
    channel: "events",
    kind: "deferred_task_completed",
    runId: source.id,
    projectId: source.projectId,
    deferredTaskId,
    exitCode,
    continuationRunId: result.runId,
  });
}

interface ContinuationContextOpts {
  summary: string;
  continuation: string;
  command: string;
  exitCode: number;
  logPath: string;
  tail: string;
  finalStatus: "completed" | "failed";
}

function renderContinuationContext(opts: ContinuationContextOpts): string {
  const outcomeChip = opts.finalStatus === "completed" ? "✓ completed" : "✗ failed";
  const tailBlock =
    opts.tail.length > 0
      ? `\n\n### Log tail\n\n\`\`\`\n${opts.tail.trimEnd()}\n\`\`\``
      : "\n\n### Log tail\n\n(no output captured)";
  return `## Deferred task continuation

A previous turn deferred long-running work to Factory. That work has now
finished; this turn is the continuation. **You have no memory of the
prior turn** — \`claude --print\` does not carry session context across
\`--resume\`. Use the notes below as your only state.

### What you (a prior turn) deferred

${opts.summary}

### Your continuation prompt to yourself

${opts.continuation}

### Outcome

- Status: ${outcomeChip}
- Exit code: ${opts.exitCode}
- Command: \`${opts.command}\`
- Full log: \`${opts.logPath}\` (read with \`cat\` if you need more than the tail)${tailBlock}`;
}

async function readLogTail(logPath: string, maxBytes: number): Promise<string> {
  try {
    const contents = await readFile(logPath, "utf8");
    if (contents.length <= maxBytes) return contents;
    return `…(truncated ${contents.length - maxBytes} bytes)…\n${contents.slice(-maxBytes)}`;
  } catch {
    return "";
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Cancel an in-progress deferred task. Marks the row cancelled and
 * SIGTERMs the pid (best-effort — the operator may have killed it
 * manually, or the process group may already have died). When the
 * `proc.exited` future eventually resolves, `onDeferredCompletion`
 * sees the cancelled status and skips the continuation submit.
 */
export type CancelDeferredResult =
  | { ok: true; cancelled: true; pid: number | null }
  | { ok: true; cancelled: false; alreadyTerminal: DeferredTaskStatus };

export class DeferredTaskNotFoundError extends Error {
  constructor(public readonly deferredTaskId: string) {
    super(`deferred task not found: ${deferredTaskId}`);
    this.name = "DeferredTaskNotFoundError";
  }
}

export async function cancelDeferredTask(
  deps: DeferredOrchestrateDeps,
  deferredTaskId: string,
): Promise<CancelDeferredResult> {
  const { db } = deps;
  const task = await db
    .select()
    .from(schema.deferredTasks)
    .where(eq(schema.deferredTasks.id, deferredTaskId))
    .get();
  if (!task) throw new DeferredTaskNotFoundError(deferredTaskId);
  if (task.status !== "running" && task.status !== "queued") {
    return { ok: true, cancelled: false, alreadyTerminal: task.status };
  }

  if (task.pid != null) {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await db
    .update(schema.deferredTasks)
    .set({ status: "cancelled", endedAt: Date.now() })
    .where(eq(schema.deferredTasks.id, deferredTaskId));
  return { ok: true, cancelled: true, pid: task.pid };
}

/**
 * Boot-time recovery. Any deferred_tasks rows still tagged `running` or
 * `queued` belong to a daemon process that's gone — we lost the
 * `proc.exited` handle. The subprocess itself MAY still be alive
 * (children get reparented to init, not killed, when the daemon dies).
 * Mark them `orphaned` so the operator can decide; we don't auto-submit
 * a continuation because we don't know if the work actually finished
 * cleanly.
 *
 * Subprocess pids are NOT auto-killed here — operator may want to let
 * a long-running build finish and pick up its output manually.
 */
export async function recoverOrphanedDeferredTasks(db: Db, events: EventBus): Promise<number> {
  const orphans = await db
    .select({
      id: schema.deferredTasks.id,
      runId: schema.deferredTasks.runId,
      projectId: schema.deferredTasks.projectId,
      pid: schema.deferredTasks.pid,
    })
    .from(schema.deferredTasks)
    .where(inArray(schema.deferredTasks.status, ["running", "queued"]))
    .all();
  if (orphans.length === 0) return 0;

  await db
    .update(schema.deferredTasks)
    .set({ status: "orphaned", endedAt: Date.now() })
    .where(
      inArray(
        schema.deferredTasks.id,
        orphans.map((o) => o.id),
      ),
    );

  for (const o of orphans) {
    events.publish({
      channel: "events",
      kind: "deferred_task_orphaned",
      runId: o.runId,
      projectId: o.projectId,
      deferredTaskId: o.id,
      pid: o.pid,
    });
  }
  return orphans.length;
}
