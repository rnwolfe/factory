import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { followFileLines } from "../tail.ts";
import { shellQuote, startTmuxSession } from "../tmux.ts";
import type { SandboxSpec, SpawnHandle, SpawnOpts } from "../types.ts";

/**
 * Host-mode sandbox. Spawns the agent inside a detached tmux session, captures
 * its stdout (line-buffered) via `pipe-pane` to a log file we tail.
 */
export const hostSandbox: SandboxSpec = {
  kind: "host",

  async spawn(opts: SpawnOpts): Promise<SpawnHandle> {
    const { worktreePath, argv, stdin, env, abort, onLine, tmux } = opts;

    // Materialize stdin into a temp file we can shell-redirect on.
    const stdinPath = path.join(
      tmpdir(),
      `factory-stdin-${tmux.sessionName.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`,
    );
    if (stdin !== undefined) {
      await writeFile(stdinPath, stdin, "utf8");
    } else {
      await writeFile(stdinPath, "", "utf8");
    }

    // Truncate the log socket so we tail from offset 0 unambiguously.
    await writeFile(tmux.logSocketPath, "", "utf8");

    // Build inner shell command. Quote each argv token; redirect stdin if provided.
    // The leading `sleep 0.15` gives pipe-pane time to attach before the inner
    // command produces output (otherwise short-lived commands can finish — and
    // tear down the session — before we attach).
    const quotedArgv = argv.map(shellQuote).join(" ");
    const inner = stdin !== undefined ? `${quotedArgv} < ${shellQuote(stdinPath)}` : quotedArgv;
    const innerCommand = `sh -c ${shellQuote(`sleep 0.15; ${inner}`)}`;

    const session = await startTmuxSession({
      sessionName: tmux.sessionName,
      cwd: worktreePath,
      command: innerCommand,
      logSocketPath: tmux.logSocketPath,
      env,
    });

    // Begin tailing the log; route lines into onLine.
    const tail = followFileLines(tmux.logSocketPath, onLine, abort);

    const pid = (await session.panePid()) ?? -1;

    const exitPromise: Promise<{ exitCode: number }> = (async () => {
      // Poll session presence until it disappears or we are aborted.
      while (!abort.aborted) {
        if (!(await session.exists())) break;
        await Bun.sleep(150);
      }
      // Ensure tail flushes whatever remains.
      await tail.drain();
      // Best-effort cleanup; the session may already be gone.
      if (await session.exists()) {
        await session.kill();
      }
      // Exit code: tmux discards the inner process exit, so we return 0 on
      // clean session disappearance and 130 on abort. Callers consult
      // `agent_exit` events for richer signal.
      return { exitCode: abort.aborted ? 130 : 0 };
    })();

    const kill = async () => {
      try {
        if (await session.exists()) {
          await session.kill();
        }
      } finally {
        await tail.stop();
      }
    };

    abort.addEventListener("abort", () => {
      void kill();
    });

    return {
      pid,
      tmuxSession: tmux.sessionName,
      exit: exitPromise,
      kill,
    };
  },
};
