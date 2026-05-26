import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import {
  ensureWorktree,
  followFileBytes,
  mergeIntoMain,
  removeWorktree,
  shellQuote,
  startTmuxSession,
  type TailHandle,
  type TmuxSessionHandle,
} from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import { getAgentDescriptor } from "../agents/registry.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { recordMergeFailure } from "../workers/merge-failure.ts";

export class SessionError extends Error {
  constructor(
    public readonly code:
      | "project_not_found"
      | "session_not_found"
      | "session_not_running"
      | "concurrent_session"
      | "tmux_failed"
      | "no_tmux"
      | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

interface ActiveHandle {
  sessionId: string;
  tmux: TmuxSessionHandle;
  tail: TailHandle;
  abort: AbortController;
}

/**
 * In-process registry of active session handles. Daemon-restart resilience is
 * provided by `recoverOrphanedSessions` in workers/recover.ts — handles in
 * this map don't survive daemon restart, but the DB row + worktree do.
 */
class SessionRegistry {
  private map = new Map<string, ActiveHandle>();
  set(id: string, h: ActiveHandle): void {
    this.map.set(id, h);
  }
  get(id: string): ActiveHandle | undefined {
    return this.map.get(id);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
}

const registry = new SessionRegistry();

async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = bunSpawn({ cmd: ["tmux", "-V"], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function countCommitsAhead(workdir: string, branch: string): Promise<number> {
  const proc = bunSpawn({
    cmd: ["git", "rev-list", "--count", `main..${branch}`],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Session modes. `shell` is the harness-free path (the operator's `$SHELL`).
 * Every other value names an agent registered in `AGENT_REGISTRY` — adding a
 * new agent automatically grows the set of valid modes since the orchestrator
 * looks up the launch command via {@link buildSessionCommand}.
 */
export type SessionMode = "shell" | "claude-code" | "codex";

interface StartInput {
  projectId: string;
  /** `SessionMode` or the legacy `"claude"` alias. Normalized inside. */
  mode?: SessionMode | "claude";
  description?: string | null;
}

/**
 * Resolve the inner shell command for a session mode. For `shell` mode this
 * is the operator's `$SHELL`; for agent modes it's the agent descriptor's
 * `buildInteractiveCommand()`. Throws when the agent doesn't support
 * interactive sessions (no descriptor will register `interactiveSession=true`
 * without a `buildInteractiveCommand`, but defense-in-depth).
 */
function buildSessionCommand(mode: SessionMode): string {
  if (mode === "shell") return `exec ${"$"}{SHELL:-/bin/sh}`;
  const descriptor = getAgentDescriptor(mode);
  if (!descriptor) throw new SessionError("invalid_input", `unknown session mode "${mode}"`);
  if (!descriptor.supports.interactiveSession || !descriptor.buildInteractiveCommand) {
    throw new SessionError("invalid_input", `agent "${mode}" doesn't support interactive sessions`);
  }
  return descriptor.buildInteractiveCommand();
}

/**
 * Normalize a session-mode input value. The PWA passes the canonical
 * `claude-code` / `codex` / `shell`, but the legacy enum value `claude` is
 * still accepted for back-compat (older clients, hand-issued tRPC calls)
 * and aliased to `claude-code`. Defaults to `claude-code` (matches the
 * column default for INSERTs without an explicit mode).
 */
function resolveModeFromInput(raw: string | undefined): SessionMode {
  if (raw === undefined) return "claude-code";
  if (raw === "claude") return "claude-code";
  if (raw === "shell" || raw === "claude-code" || raw === "codex") return raw;
  throw new SessionError("invalid_input", `unknown session mode "${raw}"`);
}

export async function startSession(
  config: FactoryConfig,
  db: Db,
  events: EventBus,
  input: StartInput,
): Promise<{ id: string; branchName: string; worktreePath: string }> {
  if (!(await tmuxAvailable())) {
    throw new SessionError("no_tmux", "tmux is not available on PATH");
  }
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();
  if (!project) {
    throw new SessionError("project_not_found", `project ${input.projectId} not found`);
  }
  // Refuse if a session for this project is already running.
  const existing = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(eq(schema.sessions.projectId, input.projectId), eq(schema.sessions.status, "running")),
    )
    .all();
  if (existing.length > 0) {
    throw new SessionError(
      "concurrent_session",
      `a session is already running for this project (id=${existing[0]?.id})`,
    );
  }

  const sessionId = createId();
  const branchName = `factory/adhoc-${sessionId.slice(0, 12)}`;
  const wt = await ensureWorktree({
    projectPath: project.workdirPath,
    branch: branchName,
    worktreePath: path.join(config.worktreesRoot, project.slug, sessionId),
  });

  // Log file for tmux pipe-pane → followFileLines → events bus.
  const logsDir = path.join(config.worktreesRoot, project.slug, "_session-logs");
  await mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${sessionId}.log`);
  await writeFile(logPath, "", "utf8");

  const sessionName = `factoryd-session-${sessionId.slice(0, 12)}`;
  // Mode → inner shell command via the agent registry. `shell` mode uses
  // the operator's $SHELL with /bin/sh fallback; any agent mode (claude-code,
  // codex, future harnesses) routes through `buildInteractiveCommand` so new
  // agents become valid session modes by adding a single registry entry.
  const mode: SessionMode = resolveModeFromInput(input.mode);
  const command = buildSessionCommand(mode);
  const innerCommand = `sh -c ${shellQuote(`sleep 0.15; ${command}`)}`;

  let tmux: TmuxSessionHandle;
  try {
    tmux = await startTmuxSession({
      sessionName,
      cwd: wt.worktreePath,
      command: innerCommand,
      logSocketPath: logPath,
      env: { TERM: "xterm-256color" },
    });
  } catch (err) {
    // Worktree was created but tmux failed — best-effort cleanup.
    await removeWorktree({
      projectPath: project.workdirPath,
      worktreePath: wt.worktreePath,
      force: true,
    }).catch(() => {});
    throw new SessionError("tmux_failed", (err as Error).message);
  }

  await db.insert(schema.sessions).values({
    id: sessionId,
    projectId: project.id,
    status: "running",
    mode,
    description: input.description ?? null,
    branchName,
    worktreePath: wt.worktreePath,
    startedAt: Date.now(),
    commitCount: 0,
  });

  // Fan tmux pane bytes onto the existing /ws/pane channel using the
  // session id as the carrier (cuid namespace is shared with runs).
  // Byte-level tail (not line-level) so per-character pty echoes flush
  // immediately — otherwise an interactive shell would only render
  // typed characters after the user presses Enter.
  const abort = new AbortController();
  const tail = followFileBytes(
    logPath,
    (chunk) => {
      events.publish({
        channel: "pane",
        runId: sessionId,
        bytes: chunk,
      });
    },
    abort.signal,
  );
  registry.set(sessionId, { sessionId, tmux, tail, abort });

  events.publish({
    channel: "inbox",
    kind: "session_started",
    sessionId,
    projectId: project.id,
  });

  return { id: sessionId, branchName, worktreePath: wt.worktreePath };
}

interface EndOpts {
  /** When true, kill tmux immediately and skip the merge attempt. */
  abort?: boolean;
}

export async function endSession(
  config: FactoryConfig,
  db: Db,
  events: EventBus,
  sessionId: string,
  opts: EndOpts = {},
): Promise<{
  status: "ended" | "merged" | "merge_failed" | "aborted";
  commitCount: number;
  mergeError?: string | null;
  decisionId?: string | null;
}> {
  const row = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!row) throw new SessionError("session_not_found", `session ${sessionId} not found`);
  if (row.status !== "running") {
    return { status: row.status, commitCount: row.commitCount };
  }
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId))
    .get();
  if (!project) {
    throw new SessionError("project_not_found", `project ${row.projectId} not found`);
  }

  // Tear down tmux + tail.
  const handle = registry.get(sessionId);
  if (handle) {
    handle.abort.abort();
    try {
      if (await handle.tmux.exists()) await handle.tmux.kill();
    } catch {
      // ignore
    }
    await handle.tail.stop().catch(() => {});
    registry.delete(sessionId);
  }

  const commitCount = await countCommitsAhead(project.workdirPath, row.branchName);
  const endedAt = Date.now();

  if (opts.abort) {
    await db
      .update(schema.sessions)
      .set({ status: "aborted", endedAt, commitCount })
      .where(eq(schema.sessions.id, sessionId));
    events.publish({
      channel: "inbox",
      kind: "session_ended",
      sessionId,
      projectId: project.id,
      status: "aborted",
      commitCount,
    });
    return { status: "aborted", commitCount };
  }

  if (commitCount === 0) {
    // Nothing committed — clean up the worktree and branch quietly.
    await removeWorktree({
      projectPath: project.workdirPath,
      worktreePath: row.worktreePath,
      force: true,
    }).catch(() => {});
    await db
      .update(schema.sessions)
      .set({ status: "ended", endedAt, commitCount: 0 })
      .where(eq(schema.sessions.id, sessionId));
    events.publish({
      channel: "inbox",
      kind: "session_ended",
      sessionId,
      projectId: project.id,
      status: "ended",
      commitCount: 0,
    });
    return { status: "ended", commitCount: 0 };
  }

  // Try merging into main, same way runs do.
  const merge = await mergeIntoMain({
    projectPath: project.workdirPath,
    branch: row.branchName,
    message: `chore: merge ad-hoc session ${sessionId.slice(0, 8)}`,
    author: config.gitAuthor,
  });
  if (merge.ok) {
    await db
      .update(schema.sessions)
      .set({ status: "merged", endedAt, commitCount, mergedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId));
    events.publish({
      channel: "inbox",
      kind: "session_ended",
      sessionId,
      projectId: project.id,
      status: "merged",
      commitCount,
    });
    return { status: "merged", commitCount };
  }

  const mergeError = `${merge.reason}: ${merge.message}`;
  await db
    .update(schema.sessions)
    .set({ status: "merge_failed", endedAt, commitCount, mergeError })
    .where(eq(schema.sessions.id, sessionId));

  // Surface a merge_failure decision so the operator gets the same recovery
  // affordances run merge failures already get.
  const decisionId = await recordMergeFailure(db, events, {
    projectId: project.id,
    reason: merge.reason,
    message: merge.message,
    payload: {
      sessionId,
      branch: row.branchName,
      reason: merge.reason,
      message: merge.message,
    },
  });
  events.publish({
    channel: "inbox",
    kind: "session_ended",
    sessionId,
    projectId: project.id,
    status: "merge_failed",
    commitCount,
  });
  return { status: "merge_failed", commitCount, mergeError, decisionId };
}

export async function abortSession(
  config: FactoryConfig,
  db: Db,
  events: EventBus,
  sessionId: string,
): Promise<void> {
  await endSession(config, db, events, sessionId, { abort: true });
}

/**
 * On daemon start, mark any session rows still tagged `running` as `aborted`
 * — their tmux session went away with the daemon. Branch and commits stay
 * on disk; the operator can inspect or merge manually.
 */
export async function recoverOrphanedSessions(db: Db, events: EventBus): Promise<number> {
  const orphans = await db
    .select({ id: schema.sessions.id, projectId: schema.sessions.projectId })
    .from(schema.sessions)
    .where(eq(schema.sessions.status, "running"))
    .all();
  if (orphans.length === 0) return 0;
  const ids = orphans.map((o) => o.id);
  await db
    .update(schema.sessions)
    .set({
      status: "aborted",
      endedAt: Date.now(),
      mergeError: "orphaned by daemon restart",
    })
    .where(inArray(schema.sessions.id, ids));
  for (const o of orphans) {
    events.publish({
      channel: "inbox",
      kind: "session_ended",
      sessionId: o.id,
      projectId: o.projectId,
      status: "aborted",
      commitCount: 0,
    });
  }
  return orphans.length;
}

export function isSessionActive(sessionId: string): boolean {
  return registry.get(sessionId) !== undefined;
}

/** Tmux session name for an active session, or null. */
export function tmuxNameForSession(sessionId: string): string | null {
  return registry.get(sessionId)?.tmux.sessionName ?? null;
}
