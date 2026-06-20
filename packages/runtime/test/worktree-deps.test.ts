import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureWorktreeDeps } from "../src/worktree.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wt-deps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureWorktreeDeps", () => {
  test("skips when there is no package.json", async () => {
    const r = await ensureWorktreeDeps(dir);
    expect(r.status).toBe("skipped");
  });

  test("reports present when node_modules already exists (no install)", async () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "bun.lock"), "");
    mkdirSync(path.join(dir, "node_modules"));
    const r = await ensureWorktreeDeps(dir);
    expect(r.status).toBe("present");
  });

  test("skips a non-bun project (package.json but no bun lockfile)", async () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "package-lock.json"), "{}");
    const r = await ensureWorktreeDeps(dir);
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no bun lockfile");
  });
});
