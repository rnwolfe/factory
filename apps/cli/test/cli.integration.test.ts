import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDown } from "../src/commands/down.ts";
import { parseLogsArgs, runLogs } from "../src/commands/logs.ts";
import { runRestart } from "../src/commands/restart.ts";
import { runStatus } from "../src/commands/status.ts";
import { runUp } from "../src/commands/up.ts";

let tmpDir: string;
let argLog: string;

function writeFakeBin(name: string, body: string): string {
  const p = path.join(tmpDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "factory-cli-"));
  argLog = path.join(tmpDir, "args.log");

  // Fake systemctl that records argv and exits 0 by default.
  process.env.FACTORY_CLI_SYSTEMCTL = writeFakeBin(
    "systemctl",
    `printf '%s\\n' "$*" >> "${argLog}"; exit 0`,
  );
  process.env.FACTORY_CLI_JOURNALCTL = writeFakeBin(
    "journalctl",
    `printf '%s\\n' "$*" >> "${argLog}"; printf 'log line 1\\nlog line 2\\n'; exit 0`,
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FACTORY_CLI_SYSTEMCTL;
  delete process.env.FACTORY_CLI_JOURNALCTL;
});

function readArgLog(): string[] {
  return Bun.file(argLog)
    .text()
    .then((t) => t.trim().split("\n").filter(Boolean)) as unknown as string[];
}

async function readArgs(): Promise<string[]> {
  const txt = await Bun.file(argLog).text();
  return txt.trim().split("\n").filter(Boolean);
}

describe("cli wrappers", () => {
  test("up forwards to systemctl --user start factory", async () => {
    const code = await runUp();
    expect(code).toBe(0);
    const lines = await readArgs();
    expect(lines[0]).toBe("--user start factory");
  });

  test("down forwards stop", async () => {
    const code = await runDown();
    expect(code).toBe(0);
    const lines = await readArgs();
    expect(lines[0]).toBe("--user stop factory");
  });

  test("restart forwards restart", async () => {
    const code = await runRestart();
    expect(code).toBe(0);
    const lines = await readArgs();
    expect(lines[0]).toBe("--user restart factory");
  });

  test("status returns 0 even when systemctl exits non-zero on inactive unit", async () => {
    process.env.FACTORY_CLI_SYSTEMCTL = writeFakeBin(
      "systemctl-inactive",
      `printf '%s\\n' "$*" >> "${argLog}"; printf 'inactive\\n'; exit 3`,
    );
    const code = await runStatus();
    expect(code).toBe(0);
  });

  test("unit-not-found surfaces exit 2 with a clear message", async () => {
    process.env.FACTORY_CLI_SYSTEMCTL = writeFakeBin(
      "systemctl-nounit",
      `>&2 printf 'Unit factory.service could not be found.\\n'; exit 5`,
    );
    const code = await runUp();
    expect(code).toBe(2);
  });

  test("logs reads N lines via journalctl", async () => {
    const code = await runLogs({ follow: false, lines: 50, since: undefined });
    expect(code).toBe(0);
    const lines = await readArgs();
    expect(lines[0]).toContain("--user -u factory -n 50 --no-pager");
  });

  test("logs --since passes the expression through", async () => {
    const code = await runLogs({ follow: false, lines: 100, since: "1 hour ago" });
    expect(code).toBe(0);
    const lines = await readArgs();
    expect(lines[0]).toContain("--since 1 hour ago");
  });

  test("parseLogsArgs handles -f, -n, --since equals form", () => {
    expect(parseLogsArgs(["-f"])).toEqual({ follow: true, lines: 100, since: undefined });
    expect(parseLogsArgs(["-n", "200"]).lines).toBe(200);
    expect(parseLogsArgs(["--lines=300"]).lines).toBe(300);
    expect(parseLogsArgs(["--since", "yesterday"]).since).toBe("yesterday");
    expect(parseLogsArgs(["--since=yesterday"]).since).toBe("yesterday");
  });
});

// Silence unused-import warning from the unused readArgLog helper.
void readArgLog;
