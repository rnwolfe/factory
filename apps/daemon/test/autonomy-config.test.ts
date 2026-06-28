import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { BUILTIN_AUTONOMY, resolveAutonomyConfig } from "../src/autonomy/config.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "autonomy-cfg-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return { db: createDb(dbPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function setSystem(db: ReturnType<typeof createDb>, partial: object) {
  db.insert(schema.settings)
    .values({ key: "autonomy-config", value: JSON.stringify(partial), updatedAt: 1 })
    .run();
}

function addProject(db: ReturnType<typeof createDb>, override: object | null): string {
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
      autonomyConfig: override ? JSON.stringify(override) : null,
    })
    .run();
  return id;
}

describe("resolveAutonomyConfig", () => {
  test("no overrides → exactly the built-in defaults", () => {
    const { db, cleanup } = setup();
    try {
      expect(resolveAutonomyConfig(db)).toEqual(BUILTIN_AUTONOMY);
      expect(resolveAutonomyConfig(db).autorun.enabled).toBe(false); // conservative default
    } finally {
      cleanup();
    }
  });

  test("system setting deep-merges over built-in; untouched keys inherit", () => {
    const { db, cleanup } = setup();
    try {
      setSystem(db, { trust: { promoteStreak: 3 } });
      const cfg = resolveAutonomyConfig(db);
      expect(cfg.trust.promoteStreak).toBe(3); // overridden
      expect(cfg.trust.autoPromote).toBe(true); // sibling inherited
      expect(cfg.gate.minLevel).toBe("high"); // other section inherited
    } finally {
      cleanup();
    }
  });

  test("project override wins over system wins over built-in", () => {
    const { db, cleanup } = setup();
    try {
      setSystem(db, { trust: { promoteStreak: 3 } });
      const projectId = addProject(db, {
        trust: { promoteStreak: 8 },
        autorun: { enabled: true },
      });
      const cfg = resolveAutonomyConfig(db, projectId);
      expect(cfg.trust.promoteStreak).toBe(8); // project beats system
      expect(cfg.autorun.enabled).toBe(true); // project
      expect(cfg.trust.autoContract).toBe(true); // built-in inherited through both
      // and without the project context, the system value still applies:
      expect(resolveAutonomyConfig(db).trust.promoteStreak).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("malformed override JSON is ignored (falls back to the lower scope)", () => {
    const { db, cleanup } = setup();
    try {
      const id = createId();
      const now = Date.now();
      db.insert(schema.projects)
        .values({
          id,
          slug: "bad",
          name: "P",
          ceremony: "personal",
          workdirPath: "/tmp/bad",
          createdAt: now,
          lastActivityAt: now,
          autonomyConfig: "{not json",
        })
        .run();
      expect(resolveAutonomyConfig(db, id)).toEqual(BUILTIN_AUTONOMY);
    } finally {
      cleanup();
    }
  });
});
