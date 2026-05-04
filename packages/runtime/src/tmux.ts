import { spawn as bunSpawn } from "bun";

async function tmux(
  args: string[],
  opts: { check?: boolean } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = bunSpawn({
    cmd: ["tmux", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (opts.check && exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
  }
  return { exitCode, stdout, stderr };
}

export interface TmuxSessionInit {
  sessionName: string;
  cwd: string;
  command: string;
  logSocketPath: string;
  env?: Record<string, string>;
}

export interface TmuxSessionHandle {
  sessionName: string;
  logSocketPath: string;
  exists(): Promise<boolean>;
  kill(): Promise<void>;
  /** Returns the PID of the session's first window's first pane. */
  panePid(): Promise<number | null>;
}

/**
 * Start a detached tmux session running `command` in `cwd`. Pipe pane output to
 * `logSocketPath` (a regular file works for v0.1; named pipes are a v0.2 path).
 */
export async function startTmuxSession(init: TmuxSessionInit): Promise<TmuxSessionHandle> {
  const { sessionName, cwd, command, logSocketPath, env } = init;

  // Build env-prefix for the inner shell. tmux honours -e on new-session.
  const envArgs: string[] = [];
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      envArgs.push("-e", `${k}=${v}`);
    }
  }

  await tmux(["new-session", "-d", "-s", sessionName, "-c", cwd, ...envArgs, command], {
    check: true,
  });

  // Defensive: ensure the pane disappears the instant its command exits. If
  // the user's tmux config sets `remain-on-exit on` globally, our exit-poll
  // loop in the host sandbox never breaks and the runtime hangs.
  await tmux(["set-option", "-t", sessionName, "remain-on-exit", "off"]);

  // -o appends; -O captures the existing scrollback first. We use -o for stream-style.
  await tmux(
    ["pipe-pane", "-o", "-t", `${sessionName}:0.0`, `cat >> ${shellQuote(logSocketPath)}`],
    { check: true },
  );

  return {
    sessionName,
    logSocketPath,
    async exists() {
      const r = await tmux(["has-session", "-t", sessionName]);
      return r.exitCode === 0;
    },
    async kill() {
      await tmux(["kill-session", "-t", sessionName]);
    },
    async panePid() {
      const r = await tmux(["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_pid}"]);
      if (r.exitCode !== 0) return null;
      const pid = Number.parseInt(r.stdout.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    },
  };
}

/**
 * Single-quote a string for safe inclusion in a shell command. Wraps in `'…'`
 * and escapes embedded single quotes via the standard `'\''` trick.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
