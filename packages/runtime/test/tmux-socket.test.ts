import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmuxSocketArgs } from "../src/tmux.ts";

/**
 * `tmuxSocketArgs` must NEVER resolve to the ambient default tmux socket in
 * normal operation. If it returns `[]` when the daemon is running, run panes
 * land on `/tmp/tmux-<uid>/default` — typically the operator's own
 * interactive/iTerm2 tmux server — and any disturbance to that server kills
 * the runs mid-flight (the "wide bun test kills the run" root cause). These
 * tests pin the resolution order so that regression can't silently return.
 */
describe("tmuxSocketArgs", () => {
  let prevSocket: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevSocket = process.env.FACTORY_TMUX_SOCKET;
    prevHome = process.env.FACTORY_HOME;
    delete process.env.FACTORY_TMUX_SOCKET;
    delete process.env.FACTORY_HOME;
  });

  afterEach(() => {
    if (prevSocket === undefined) delete process.env.FACTORY_TMUX_SOCKET;
    else process.env.FACTORY_TMUX_SOCKET = prevSocket;
    if (prevHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = prevHome;
  });

  test("explicit socket is used verbatim", () => {
    process.env.FACTORY_TMUX_SOCKET = "factory-test-42";
    expect(tmuxSocketArgs()).toEqual(["-L", "factory-test-42"]);
  });

  test("explicit empty string opts out to the ambient default server", () => {
    process.env.FACTORY_TMUX_SOCKET = "";
    expect(tmuxSocketArgs()).toEqual([]);
  });

  test("unset derives a dedicated per-instance socket from FACTORY_HOME", () => {
    process.env.FACTORY_HOME = "/home/rnwolfe/.factory-live";
    expect(tmuxSocketArgs()).toEqual(["-L", "factory-live"]);
  });

  test("dev FACTORY_HOME resolves to a distinct socket from prod", () => {
    process.env.FACTORY_HOME = "/home/rnwolfe/.factory";
    expect(tmuxSocketArgs()).toEqual(["-L", "factory"]);
  });

  test("trailing slash on FACTORY_HOME is tolerated", () => {
    process.env.FACTORY_HOME = "/home/rnwolfe/.factory-live/";
    expect(tmuxSocketArgs()).toEqual(["-L", "factory-live"]);
  });

  test("unset socket with no FACTORY_HOME still never returns the default socket", () => {
    // Absent everything, we must STILL pass a dedicated socket — the one thing
    // we can never do is return [] and share the operator's default server.
    expect(tmuxSocketArgs()).toEqual(["-L", "factory"]);
  });
});
