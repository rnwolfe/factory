import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInstall } from "../src/commands/install.ts";
import { runUninstall } from "../src/commands/uninstall.ts";
import { unitPath } from "../src/lib/unit.ts";

let tmpRoot: string;
let xdg: string;
let checkout: string;
let home: string;
let argLog: string;

function writeFakeBin(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "factory-install-"));
  xdg = path.join(tmpRoot, "config");
  checkout = path.join(tmpRoot, "checkout");
  home = path.join(tmpRoot, "factory-home");
  argLog = path.join(tmpRoot, "args.log");

  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "factory" }), "utf8");

  process.env.XDG_CONFIG_HOME = xdg;
  process.env.FACTORY_CLI_SYSTEMCTL = writeFakeBin(
    "systemctl",
    `printf '%s\\n' "$*" >> "${argLog}"; exit 0`,
  );
  process.env.FACTORY_CLI_LOGINCTL = writeFakeBin(
    "loginctl",
    `printf '%s\\n' "$*" >> "${argLog}"; exit 0`,
  );
  process.env.FACTORY_CLI_BUN = "/usr/bin/env bun";
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.FACTORY_CLI_SYSTEMCTL;
  delete process.env.FACTORY_CLI_LOGINCTL;
  delete process.env.FACTORY_CLI_BUN;
});

describe("factory install", () => {
  test("writes unit, daemon-reloads, enables --now", async () => {
    const code = await runInstall({ checkout, home, force: false, yes: true });
    expect(code).toBe(0);
    const unit = unitPath();
    expect(existsSync(unit)).toBe(true);
    const content = readFileSync(unit, "utf8");
    expect(content).toContain("Type=notify");
    expect(content).toContain("NotifyAccess=all");
    expect(content).toContain(`WorkingDirectory=${checkout}`);
    expect(content).toContain(`Environment=FACTORY_HOME=${home}`);
    expect(content).toContain(`ExecStart=/usr/bin/env bun run --cwd ${checkout} start`);
    const args = readFileSync(argLog, "utf8");
    expect(args).toContain("--user daemon-reload");
    expect(args).toContain("--user enable --now factory");
    expect(args).toContain("enable-linger");
  });

  test("refuses to clobber existing unit without --force", async () => {
    await runInstall({ checkout, home, force: false, yes: true });
    const original = readFileSync(unitPath(), "utf8");
    const code = await runInstall({
      checkout,
      home: path.join(tmpRoot, "different-home"),
      force: false,
      yes: true,
    });
    expect(code).toBe(1);
    expect(readFileSync(unitPath(), "utf8")).toBe(original);
  });

  test("--force overwrites the unit and re-enables", async () => {
    await runInstall({ checkout, home, force: false, yes: true });
    const code = await runInstall({
      checkout,
      home: path.join(tmpRoot, "different-home"),
      force: true,
      yes: true,
    });
    expect(code).toBe(0);
    const content = readFileSync(unitPath(), "utf8");
    expect(content).toContain("different-home");
  });

  test("rejects a non-Factory checkout", async () => {
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "other" }), "utf8");
    const code = await runInstall({ checkout, home, force: false, yes: true });
    expect(code).toBe(1);
    expect(existsSync(unitPath())).toBe(false);
  });

  test("succeeds without loginctl (degrades gracefully)", async () => {
    process.env.FACTORY_CLI_LOGINCTL = "/nonexistent/loginctl-fake";
    // Override whichBin path for loginctl by clearing the env then forcing.
    delete process.env.FACTORY_CLI_LOGINCTL;
    // Replace whichBin lookup by setting PATH to a dir that has no loginctl.
    const isolatedPath = path.join(tmpRoot, "empty-path");
    mkdirSync(isolatedPath, { recursive: true });
    const origPath = process.env.PATH;
    process.env.PATH = isolatedPath;
    try {
      const code = await runInstall({ checkout, home, force: false, yes: true });
      expect(code).toBe(0);
      expect(existsSync(unitPath())).toBe(true);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("factory uninstall", () => {
  test("removes the unit and daemon-reloads", async () => {
    await runInstall({ checkout, home, force: false, yes: true });
    expect(existsSync(unitPath())).toBe(true);
    const code = await runUninstall();
    expect(code).toBe(0);
    expect(existsSync(unitPath())).toBe(false);
    const args = readFileSync(argLog, "utf8");
    expect(args).toContain("--user disable --now factory");
    expect(args).toContain("--user daemon-reload");
  });

  test("no-op when unit absent", async () => {
    const code = await runUninstall();
    expect(code).toBe(0);
    expect(existsSync(unitPath())).toBe(false);
  });
});
