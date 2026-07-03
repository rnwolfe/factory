import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync as bunSpawnSync } from "bun";
import {
  resizeTmuxWindow,
  sendKeysToTmux,
  startTmuxSession,
  type TmuxSessionHandle,
} from "../src/tmux.ts";

// EVERY tmux command in this suite MUST land on a private throwaway server, not
// the operator's ambient default socket. This is the hard-won fix for the wide-
// `bun test`-kills-the-parent-run bug (see CLAUDE.md / tmuxSocketArgs): real
// tmux session churn on a shared default server takes co-tenant panes down with
// it. FACTORY_TMUX_SOCKET must be a CLI flag, which tmuxSocketArgs turns into
// `-L <socket>`; setting it in-process is enough because tmux.ts reads
// process.env in-JS and passes the flag explicitly.
const tmuxSocket = `factory-tmux-test-${process.pid}`;
let prevTmuxSocket: string | undefined;

beforeAll(() => {
  prevTmuxSocket = process.env.FACTORY_TMUX_SOCKET;
  process.env.FACTORY_TMUX_SOCKET = tmuxSocket;
});

const live: TmuxSessionHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Kill any sessions a test left behind before the server-wide teardown.
  for (const h of live.splice(0)) {
    try {
      await h.kill();
    } catch {
      // ignore — may already be gone
    }
  }
});

afterAll(() => {
  // Tear down this suite's private tmux server by its explicit socket — never
  // touches a shared/default server.
  try {
    bunSpawnSync({
      cmd: ["tmux", "-L", tmuxSocket, "kill-server"],
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // ignore — server may already be gone
  }
  if (prevTmuxSocket === undefined) delete process.env.FACTORY_TMUX_SOCKET;
  else process.env.FACTORY_TMUX_SOCKET = prevTmuxSocket;
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "tmux-test-"));
  dirs.push(d);
  return d;
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await Bun.sleep(50);
  }
  return false;
}

function uniqueSession(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

describe("startTmuxSession lifecycle", () => {
  test("creates a session that exists, then kill() removes it", async () => {
    const cwd = tmpDir();
    const handle = await startTmuxSession({
      sessionName: uniqueSession("life"),
      cwd,
      // A long-lived shell so the session stays up until we kill it.
      command: "sh -c 'sleep 30'",
      logSocketPath: path.join(cwd, "pane.log"),
    });
    live.push(handle);

    expect(await handle.exists()).toBe(true);

    await handle.kill();
    expect(await waitFor(async () => !(await handle.exists()))).toBe(true);
  });

  test("panePid() returns a live PID for a running session", async () => {
    const cwd = tmpDir();
    const handle = await startTmuxSession({
      sessionName: uniqueSession("pid"),
      cwd,
      command: "sh -c 'sleep 30'",
      logSocketPath: path.join(cwd, "pane.log"),
    });
    live.push(handle);

    const pid = await handle.panePid();
    expect(pid).not.toBeNull();
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
  });
});

describe("sendKeysToTmux", () => {
  test("delivers bytes to the pane's stdin", async () => {
    const cwd = tmpDir();
    const outFile = path.join(cwd, "out.txt");
    const handle = await startTmuxSession({
      sessionName: uniqueSession("keys"),
      cwd,
      // Append each received line to out.txt, flushing per line (the redirect
      // reopens the file each iteration), so the test can observe delivery
      // without waiting for EOF.
      command: `sh -c 'while IFS= read -r line; do printf "%s\\n" "$line" >> ${outFile}; done'`,
      logSocketPath: path.join(cwd, "pane.log"),
    });
    live.push(handle);

    const ok = await sendKeysToTmux(handle.sessionName, "hello-tmux\n");
    expect(ok).toBe(true);

    const arrived = await waitFor(async () => {
      try {
        const content = await readFile(outFile, "utf8");
        return content.includes("hello-tmux");
      } catch {
        return false;
      }
    });
    expect(arrived).toBe(true);
  });

  test("empty payload is a no-op that reports success", async () => {
    // No session needed — zero-length bytes short-circuit before touching tmux.
    expect(await sendKeysToTmux("no-such-session", "")).toBe(true);
  });

  test("returns false when the target session does not exist", async () => {
    expect(await sendKeysToTmux(uniqueSession("ghost"), "x")).toBe(false);
  });
});

describe("resizeTmuxWindow", () => {
  test("resizes a live session without throwing and reports success", async () => {
    const cwd = tmpDir();
    const handle = await startTmuxSession({
      sessionName: uniqueSession("resize"),
      cwd,
      command: "sh -c 'sleep 30'",
      logSocketPath: path.join(cwd, "pane.log"),
    });
    live.push(handle);

    expect(await resizeTmuxWindow(handle.sessionName, 100, 40)).toBe(true);
  });

  test("rejects non-finite dimensions without touching tmux", async () => {
    expect(await resizeTmuxWindow("irrelevant", Number.NaN, 40)).toBe(false);
    expect(await resizeTmuxWindow("irrelevant", 100, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
