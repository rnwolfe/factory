import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../src/events.ts";
import { readPackageScripts } from "../src/scripts/package-scripts.ts";
import { ScriptError, ScriptRegistry } from "../src/scripts/registry.ts";

function makeWorkdir(scripts: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "factory-scripts-test-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts }, null, 2));
  return root;
}

async function waitFor(p: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (p()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("readPackageScripts", () => {
  test("returns scripts list", async () => {
    const root = makeWorkdir({ build: "echo build", test: "echo test" });
    try {
      const out = await readPackageScripts(root);
      expect(out).toEqual([
        { scriptName: "build", command: "echo build" },
        { scriptName: "test", command: "echo test" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns [] when no package.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-scripts-test-"));
    try {
      expect(await readPackageScripts(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ScriptRegistry", () => {
  let workdir: string;
  let events: EventBus;
  let registry: ScriptRegistry;

  beforeEach(() => {
    workdir = makeWorkdir({
      hello: "echo factory-hello",
      slow: "sleep 5",
    });
    events = new EventBus();
    registry = new ScriptRegistry(events);
  });

  afterEach(() => {
    registry.killAll();
    rmSync(workdir, { recursive: true, force: true });
  });

  test("start runs the script and broadcasts bytes; exit transitions status", async () => {
    const seen: string[] = [];
    events.subscribe((e) => {
      if (e.channel === "script") {
        seen.push(new TextDecoder().decode(e.bytes));
      }
    });
    const { handle } = registry.start({
      projectId: "p1",
      scriptName: "hello",
      command: "echo factory-hello",
      cwd: workdir,
    });
    expect(handle.status).toBe("running");
    await waitFor(() => {
      const cur = registry.get(handle.id);
      return cur != null && cur.status === "exited";
    });
    const final = registry.get(handle.id);
    expect(final?.status).toBe("exited");
    expect(final?.exitCode).toBe(0);
    expect(seen.join("")).toContain("factory-hello");
  });

  test("rejects starting the same script twice while running", async () => {
    const a = registry.start({
      projectId: "p1",
      scriptName: "slow",
      command: "sleep 5",
      cwd: workdir,
    });
    expect(a.handle.status).toBe("running");
    expect(() =>
      registry.start({
        projectId: "p1",
        scriptName: "slow",
        command: "sleep 5",
        cwd: workdir,
      }),
    ).toThrow(ScriptError);
  });

  test("stop terminates a running script", async () => {
    const { handle } = registry.start({
      projectId: "p1",
      scriptName: "slow",
      command: "sleep 30",
      cwd: workdir,
    });
    await registry.stop(handle.id);
    await waitFor(() => {
      const cur = registry.get(handle.id);
      return cur != null && cur.status !== "running";
    });
    const final = registry.get(handle.id);
    expect(final).not.toBeNull();
    if (!final) throw new Error("unreachable");
    expect(["killed", "exited", "failed"]).toContain(final.status);
  });

  test("active filters by projectId", () => {
    registry.start({
      projectId: "p1",
      scriptName: "slow",
      command: "sleep 30",
      cwd: workdir,
    });
    registry.start({
      projectId: "p2",
      scriptName: "slow",
      command: "sleep 30",
      cwd: workdir,
    });
    expect(registry.active("p1").length).toBe(1);
    expect(registry.active("p2").length).toBe(1);
    expect(registry.active().length).toBe(2);
  });

  test("stop on unknown id throws ScriptError(not_found)", async () => {
    let thrown: unknown;
    try {
      await registry.stop("nope");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ScriptError);
    if (thrown instanceof ScriptError) {
      expect(thrown.code).toBe("not_found");
    }
  });
});
