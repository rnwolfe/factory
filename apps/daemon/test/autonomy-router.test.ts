import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { autonomyRouter } from "../src/routers/autonomy.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(autonomyRouter);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "autonomy-router-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const caller = createCaller({
    db,
    authorized: true,
    config: {} as FactoryConfig,
  } as DaemonContext);
  return { db, caller, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(db: ReturnType<typeof createDb>): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: `s-${id.slice(0, 6)}`,
      name: "P",
      ceremony: "personal",
      workdirPath: `/tmp/${id}`,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

describe("autonomy router", () => {
  test("config returns resolved defaults + presets + empty overrides", async () => {
    const h = setup();
    try {
      const cfg = await h.caller.config();
      expect(cfg.resolved.trust.promoteStreak).toBe(5);
      expect(cfg.resolved.autorun.enabled).toBe(false);
      expect(cfg.systemOverride).toBeNull();
      expect(cfg.presets.conservative).toBeDefined();
      expect(cfg.presets["hands-off"].autorun?.enabled).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("setProject override resolves over the built-in (and is reported raw)", async () => {
    const h = setup();
    try {
      const projectId = addProject(h.db);
      await h.caller.setProject({ projectId, override: { trust: { promoteStreak: 9 } } });
      const cfg = await h.caller.config({ projectId });
      expect(cfg.resolved.trust.promoteStreak).toBe(9);
      expect(cfg.projectOverride?.trust?.promoteStreak).toBe(9);
      expect(cfg.resolved.trust.autoContract).toBe(true); // inherited

      // clearing reverts to inherited
      await h.caller.setProject({ projectId, override: null });
      const cleared = await h.caller.config({ projectId });
      expect(cleared.resolved.trust.promoteStreak).toBe(5);
      expect(cleared.projectOverride).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("applyPreset at project scope writes the bundle (hands-off enables auto-run)", async () => {
    const h = setup();
    try {
      const projectId = addProject(h.db);
      await h.caller.applyPreset({ scope: "project", projectId, preset: "hands-off" });
      const cfg = await h.caller.config({ projectId });
      expect(cfg.resolved.autorun.enabled).toBe(true);
      expect(cfg.resolved.trust.promoteStreak).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  test("history returns recent autonomy events, newest first, filterable by project", async () => {
    const h = setup();
    try {
      const projectId = addProject(h.db);
      for (const [i, kind] of ["gate_held", "trust_contracted"].entries()) {
        h.db
          .insert(schema.autonomyEvents)
          .values({
            id: createId(),
            projectId,
            runId: null,
            kind,
            message: kind,
            detail: null,
            createdAt: 100 + i,
          })
          .run();
      }
      const rows = await h.caller.history({ projectId });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.kind).toBe("trust_contracted"); // newest first
    } finally {
      h.cleanup();
    }
  });
});
