import { spawn as bunSpawn } from "bun";

/**
 * Dedicated tmux socket flags (`-L <name>`). Every tmux command Factory issues
 * targets a *private* tmux server, never the ambient default socket.
 *
 * Why this must never fall back to the default socket (the bug this prevents):
 * a Factory run pane is a detached tmux session, created by the daemon via
 * `tmux new-session`. With no `-L`, tmux connects to the default socket
 * `/tmp/tmux-<uid>/default` — which is whatever tmux server already owns it,
 * typically the **operator's own interactive/iTerm2 (`-CC`) session**. Every
 * run pane then becomes a co-tenant of the operator's personal tmux server, and
 * anything that disturbs that server — a self-hosting run's heavy `bun run test`
 * load, control-mode churn, the operator attaching/detaching, or a stale
 * worktree's pre-isolation test suite creating/killing sessions on the default
 * socket — takes the run panes down with it. They die mid-run before emitting a
 * `factory-status` footer and are marked `failed` ("ended without a status
 * block"). This is the real "wide `bun test` kills the run" root cause; the
 * earlier test-suite isolation was necessary but insufficient.
 *
 * Resolution order:
 *   1. `FACTORY_TMUX_SOCKET` set to a non-empty value → use it verbatim. The
 *      test suites set a unique per-suite socket so their real-tmux churn lands
 *      on a throwaway server (see the *-orchestrate + spawn integration tests).
 *   2. `FACTORY_TMUX_SOCKET=""` (explicit empty) → escape hatch: return `[]`
 *      and use the ambient default server. For deliberate manual debugging only.
 *   3. Unset (normal daemon/CLI operation) → a stable per-instance socket
 *      derived from `FACTORY_HOME`, so prod (`~/.factory-live` → `factory-live`)
 *      and dev (`~/.factory` → `factory`) daemons get distinct servers and
 *      neither ever touches the operator's default socket.
 *
 * Crucially this is a *CLI argument* computed in-process, not an inherited env
 * var: Bun snapshots a child's environment at spawn and ignores later
 * `process.env` mutations, so an env-only approach (unset `$TMUX` /
 * `TMUX_TMPDIR`) does NOT reach the spawned tmux. `-L` does, because we read
 * `process.env` here in-JS and pass the flag explicitly.
 */
export function tmuxSocketArgs(): string[] {
  const explicit = process.env.FACTORY_TMUX_SOCKET;
  if (explicit === "") return []; // explicit opt-out → ambient default server
  return ["-L", explicit ?? defaultTmuxSocket()];
}

/**
 * Stable per-instance socket name for the ambient (unset) case. Derived from
 * `FACTORY_HOME`'s basename so distinct daemons on one host don't collide, and
 * so run panes never land on the operator's default tmux server. Falls back to
 * `factory` when `FACTORY_HOME` is absent.
 */
function defaultTmuxSocket(): string {
  const home = process.env.FACTORY_HOME;
  const base = home ? (home.replace(/\/+$/, "").split("/").pop() ?? "") : "";
  const name = base.replace(/^\.+/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  return name || "factory";
}

async function tmux(
  args: string[],
  opts: { check?: boolean } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = bunSpawn({
    cmd: ["tmux", ...tmuxSocketArgs(), ...args],
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

  // Without an attached client, tmux's default `window-size latest` policy
  // leaves the window pinned at default-size (80x24) — browser-side resizes
  // routed through `resizeTmuxWindow` would not stick because tmux would
  // re-derive size on every internal event. `manual` makes explicit resizes
  // authoritative, which is what the live xterm pane needs so `$LINES`/
  // `$COLUMNS` track the actual viewport.
  await tmux(["set-option", "-t", sessionName, "window-size", "manual"]);

  // -o appends; -O captures the existing scrollback first. We use -o for
  // stream-style. `stdbuf -o0` disables stdout buffering on cat so each
  // byte tmux emits hits the log immediately — without it, an interactive
  // shell's per-character pty echo would line-buffer through cat and the
  // browser would only see typed characters after Enter.
  await tmux(
    [
      "pipe-pane",
      "-o",
      "-t",
      `${sessionName}:0.0`,
      `stdbuf -o0 cat >> ${shellQuote(logSocketPath)}`,
    ],
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

/**
 * Forward keystrokes to a tmux session's first pane. Uses `send-keys -H`
 * (hex bytes) so we can carry arbitrary control sequences from xterm.js
 * — including NUL bytes (Ctrl-Space) and escape sequences (arrow keys,
 * function keys) — without shell-quoting hazards.
 *
 * Returns true on success; false if tmux refused (session disappeared,
 * etc.). Callers should treat false as a soft signal — the WebSocket
 * handler logs+continues rather than disconnecting on a single failure.
 */
export async function sendKeysToTmux(
  sessionName: string,
  data: string | Uint8Array,
): Promise<boolean> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.length === 0) return true;
  const hex: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    hex[i] = v.toString(16).padStart(2, "0");
  }
  const r = await tmux(["send-keys", "-t", `${sessionName}:0.0`, "-H", ...hex]);
  return r.exitCode === 0;
}

/**
 * Resize the tmux window (and its sole pane) backing this session so the
 * inner program receives SIGWINCH and re-renders to the new grid. The pane
 * is detached (no client attached), so this is the only path that makes
 * `$LINES`/`$COLUMNS` track the browser's xterm.js viewport — `tmux
 * refresh-client -C` requires an attached client and `tmux resize-pane`
 * inside a one-pane window is equivalent to `resize-window`.
 *
 * Returns true on success; false if tmux refused (session gone, invalid
 * dimensions). Callers should treat false as a soft signal.
 */
export async function resizeTmuxWindow(
  sessionName: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  const c = Math.max(2, Math.floor(cols));
  const r = Math.max(2, Math.floor(rows));
  const out = await tmux([
    "resize-window",
    "-t",
    `${sessionName}:0`,
    "-x",
    String(c),
    "-y",
    String(r),
  ]);
  return out.exitCode === 0;
}
