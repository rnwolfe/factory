import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";

import { buildHealth } from "../src/health.ts";

let dbPath: string;
let tmpRoot: string;
let db: ReturnType<typeof createDb>;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "factory-health-"));
  dbPath = path.join(tmpRoot, "data.db");
  runMigrations(dbPath);
  db = createDb(dbPath);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildHealth", () => {
  test("reports ok with zero counts on a fresh db", async () => {
    const h = await buildHealth(db);
    expect(h.status).toBe("ok");
    expect(h.active_runs).toBe(0);
    expect(h.active_sessions).toBe(0);
    expect(typeof h.version).toBe("string");
    expect(h.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  test("counts running runs and sessions", async () => {
    const projectId = createId();
    await db.insert(schema.projects).values({
      id: projectId,
      slug: "p",
      name: "p",
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath: tmpRoot,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      model: null,
    });
    await db.insert(schema.runs).values({
      id: createId(),
      projectId,
      taskId: null,
      status: "running",
      branch: "factory/run-x",
      worktreePath: path.join(tmpRoot, "wt"),
      startedAt: Date.now(),
      budgetSeconds: 600,
    });
    await db.insert(schema.sessions).values({
      id: createId(),
      projectId,
      status: "running",
      mode: "claude",
      description: null,
      branchName: "factory/adhoc-y",
      worktreePath: path.join(tmpRoot, "sess"),
      startedAt: Date.now(),
      commitCount: 0,
    });

    const h = await buildHealth(db);
    expect(h.active_runs).toBe(1);
    expect(h.active_sessions).toBe(1);
    expect(h.status).toBe("ok");
  });

  test("respects FACTORY_VERSION env override", async () => {
    process.env.FACTORY_VERSION = "v0.2.0-deadbeef";
    try {
      const h = await buildHealth(db);
      expect(h.version).toBe("v0.2.0-deadbeef");
    } finally {
      delete process.env.FACTORY_VERSION;
    }
  });
});
