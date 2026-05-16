import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunResult, RunSpec, Runtime, SpawnHandle, StreamEvent } from "./types.ts";
import {
  commitAllChanges,
  ensureWorktree,
  getHeadRef,
  isWorktreeClean,
  listCommitsSince,
  removeWorktree,
} from "./worktree.ts";

const DEFAULT_GIT_AUTHOR = { name: "Factory", email: "factory@localhost" };

/**
 * Grace window between the agent's result envelope (`agent_exit`) and a
 * forced tmux teardown. See the backstop comment in `HostRuntime.spawn`.
 */
const AGENT_EXIT_GRACE_MS = 30_000;

function deriveBranch(spec: RunSpec): string {
  if (spec.strategy.type === "branch") return spec.strategy.name;
  // "head" strategy: still create a worktree on its own branch so concurrent
  // runs don't collide on a single project's HEAD. The branch name is derived
  // from the runId for uniqueness.
  return `factory/run-${spec.runId}`;
}

function tmuxSessionName(spec: RunSpec): string {
  if (spec.tmuxSessionName) return spec.tmuxSessionName;
  // tmux dislikes ':' and '.' in session names; runIds are cuid2 (alphanumeric).
  return `factory-${spec.task.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${spec.runId}`;
}

function logSocketPath(spec: RunSpec, projectPath: string): string {
  if (spec.logSocketPath) return spec.logSocketPath;
  return path.join(projectPath, ".factory", "runs", spec.runId, "log.txt");
}

class HostRuntime implements Runtime {
  async spawn(spec: RunSpec): Promise<RunResult> {
    const branch = deriveBranch(spec);
    const sessionName = tmuxSessionName(spec);
    const logPath = logSocketPath(spec, spec.projectPath);

    await mkdir(path.dirname(logPath), { recursive: true });

    const baseRef =
      spec.strategy.type === "branch"
        ? spec.strategy.baseRef
        : (spec.strategy.baseRef ?? (await getHeadRef(spec.projectPath)));

    const wt = await ensureWorktree({
      projectPath: spec.projectPath,
      branch,
      baseRef,
      worktreePath: spec.worktreePath,
    });

    const iteration = 1;
    spec.onEvent({
      kind: "iteration_start",
      iteration,
      ts: Date.now(),
      runId: spec.runId,
    });

    const { argv, stdin, env } = spec.agent.buildArgv(spec.task.prompt, {
      resumeSessionId: spec.resume?.sessionId,
      model: spec.model ?? undefined,
    });

    let agentExitCode = 0;
    let sessionId: string | undefined;
    let stalenessTripped = false;

    // Agent-exit grace backstop. Once the agent's result envelope arrives,
    // `claude --print` should exit and the tmux session should close on its
    // own — the host sandbox's exit promise only resolves when the session
    // disappears. If it hasn't after AGENT_EXIT_GRACE_MS, claude is wedged on
    // a child it spawned that holds its stdio open (a leaked dev server, an
    // un-`disown`ed background build), and the run would otherwise hang at
    // `running` indefinitely. We force the session closed so it can finalize.
    //
    // This is deliberately NOT the eager 500ms kill removed in 8c39e45: that
    // fired unconditionally and pre-empted work the harness had legitimately
    // backgrounded. This arms only on `agent_exit` and fires only if the
    // session is STILL alive long past a normal shutdown — i.e. only on a
    // genuine wedge. By then the agent has emitted its terminal verdict, so
    // nothing a surviving child does can change the run's outcome.
    let handle: SpawnHandle | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const graceMs = spec.agentExitGraceMs ?? AGENT_EXIT_GRACE_MS;

    const onLine = (line: string) => {
      // Always emit the raw line so consumers can stream pane output to xterm.
      spec.onEvent({ kind: "raw", line, runId: spec.runId, iteration });
      if (spec.agent.detectStaleness?.(line)) {
        stalenessTripped = true;
      }
      const events = spec.agent.parseLine(line);
      for (const e of events as StreamEvent[]) {
        if (e.kind === "session") sessionId = e.id;
        if (e.kind === "agent_exit") {
          agentExitCode = e.exitCode;
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              spec.onEvent({
                kind: "raw",
                line: `[runtime] agent exited but tmux session still alive after ${graceMs / 1000}s — forcing teardown`,
                runId: spec.runId,
                iteration,
              });
              void handle?.kill();
            }, graceMs);
          }
        }
        spec.onEvent({ ...e, runId: spec.runId, iteration });
      }
    };

    // Budget timer. budgetSeconds=0 means infinite (matches running the
    // Claude CLI by hand) — only the operator's abort signal can stop it.
    const budgetController = new AbortController();
    const compositeAbort = AbortSignal.any([spec.abort, budgetController.signal]);
    const budgetTimer =
      spec.budgetSeconds > 0
        ? setTimeout(() => budgetController.abort(), spec.budgetSeconds * 1000)
        : null;

    let sandboxExit = { exitCode: 0 };
    try {
      handle = await spec.sandbox.spawn({
        worktreePath: wt.worktreePath,
        argv,
        stdin,
        env: { ...process.env, ...env } as Record<string, string>,
        abort: compositeAbort,
        onLine,
        tmux: { sessionName, logSocketPath: logPath },
      });

      sandboxExit = await handle.exit;
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (graceTimer) clearTimeout(graceTimer);
    }

    const aborted = compositeAbort.aborted;
    const finalExit = aborted ? sandboxExit.exitCode || 130 : agentExitCode;

    spec.onEvent({
      kind: "iteration_end",
      iteration,
      exitCode: agentExitCode,
      ts: Date.now(),
      runId: spec.runId,
    });

    // Auto-commit residual dirty state before snapshotting commits. Without
    // this, an agent that edited files but didn't run `git commit` itself
    // leaves the worktree dirty — and the cleanup below would either preserve
    // a stranded directory or, if commits were also empty, throw the work away
    // entirely. The operator should always have a reviewable commit.
    const dirty = !(await isWorktreeClean(wt.worktreePath));
    if (dirty && !aborted) {
      try {
        const auto = await commitAllChanges(
          wt.worktreePath,
          `factory: ${spec.task.id} · run ${spec.runId.slice(0, 8)} (auto)`,
          spec.gitAuthor ?? DEFAULT_GIT_AUTHOR,
        );
        if (auto) {
          spec.onEvent({
            kind: "commit",
            sha: auto.sha,
            subject: auto.subject,
            runId: spec.runId,
            iteration,
          });
        }
      } catch (err) {
        // Don't let a commit failure (e.g., missing identity, hooks) sink the
        // run — surface it on the timeline and continue.
        spec.onEvent({
          kind: "raw",
          line: `[runtime] auto-commit failed: ${err instanceof Error ? err.message : String(err)}`,
          runId: spec.runId,
          iteration,
        });
      }
    }

    const commits = await listCommitsSince(wt.worktreePath, wt.baseHead);
    for (const c of commits) {
      spec.onEvent({
        kind: "commit",
        sha: c.sha,
        subject: c.subject,
        runId: spec.runId,
        iteration,
      });
    }

    // Cleanup worktree only when the run produced nothing — preserve any run
    // that has commits so the operator can browse the diff later.
    if (!spec.preserveWorktree && commits.length === 0) {
      const stillDirty = !(await isWorktreeClean(wt.worktreePath));
      if (!stillDirty) {
        await removeWorktree({
          projectPath: spec.projectPath,
          worktreePath: wt.worktreePath,
        });
      }
    }

    return {
      runId: spec.runId,
      branch,
      worktreePath: wt.worktreePath,
      commits,
      sessionId,
      exitCode: stalenessTripped ? 65 : finalExit,
      iterationsCompleted: iteration,
    };
  }
}

export const runtime: Runtime = new HostRuntime();
