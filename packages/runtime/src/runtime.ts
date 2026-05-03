import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunResult, RunSpec, Runtime, StreamEvent } from "./types.ts";
import {
  ensureWorktree,
  getHeadRef,
  isWorktreeClean,
  listCommitsSince,
  removeWorktree,
} from "./worktree.ts";

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
      spec.strategy.type === "branch" ? spec.strategy.baseRef : await getHeadRef(spec.projectPath);

    const wt = await ensureWorktree({
      projectPath: spec.projectPath,
      branch,
      baseRef,
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
    });

    let agentExitCode = 0;
    let sessionId: string | undefined;
    let stalenessTripped = false;

    const onLine = (line: string) => {
      // Always emit the raw line so consumers can stream pane output to xterm.
      spec.onEvent({ kind: "raw", line, runId: spec.runId, iteration });
      if (spec.agent.detectStaleness?.(line)) {
        stalenessTripped = true;
      }
      const events = spec.agent.parseLine(line);
      for (const e of events as StreamEvent[]) {
        if (e.kind === "session") sessionId = e.id;
        if (e.kind === "agent_exit") agentExitCode = e.exitCode;
        spec.onEvent({ ...e, runId: spec.runId, iteration });
      }
    };

    // Budget timer
    const budgetController = new AbortController();
    const compositeAbort = AbortSignal.any([spec.abort, budgetController.signal]);
    const budgetTimer = setTimeout(() => budgetController.abort(), spec.budgetSeconds * 1000);

    let sandboxExit = { exitCode: 0 };
    try {
      const handle = await spec.sandbox.spawn({
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
      clearTimeout(budgetTimer);
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

    // Cleanup worktree if clean and not preserved.
    const dirty = !(await isWorktreeClean(wt.worktreePath));
    if (!spec.preserveWorktree && !dirty && commits.length === 0) {
      await removeWorktree({
        projectPath: spec.projectPath,
        worktreePath: wt.worktreePath,
      });
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
