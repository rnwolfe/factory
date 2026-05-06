import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { applyPack, PackError, parsePack, serializePack } from "../src/prompts/pack.ts";

interface Harness {
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
}

function setup(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-pack-test-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function seedPrompt(
  db: ReturnType<typeof createDb>,
  key: string,
  versions: Array<{ version: number; content: string; active?: boolean }>,
) {
  for (const v of versions) {
    db.insert(schema.prompts)
      .values({
        id: createId(),
        promptKey: key,
        version: v.version,
        content: v.content,
        active: v.active === true,
        createdAt: Date.now(),
      })
      .run();
  }
}

describe("prompts pack", () => {
  test("export of empty prompts table is parseable", () => {
    const h = setup();
    try {
      const yaml = serializePack(h.db);
      const pack = parsePack(yaml);
      expect(pack.factoryPromptPack).toBe(1);
      expect(pack.prompts).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("export then parse round-trips a populated install", () => {
    const h = setup();
    try {
      seedPrompt(h.db, "triage.score", [
        { version: 1, content: "v1 body" },
        { version: 2, content: "v2 body", active: true },
      ]);
      seedPrompt(h.db, "plan.refine", [{ version: 1, content: "only", active: true }]);
      const yaml = serializePack(h.db);
      const pack = parsePack(yaml);
      expect(pack.prompts.length).toBe(2);
      const triage = pack.prompts.find((p) => p.key === "triage.score");
      expect(triage).toBeDefined();
      expect(triage?.activeVersion).toBe(2);
      expect(triage?.versions.length).toBe(2);
      const plan = pack.prompts.find((p) => p.key === "plan.refine");
      expect(plan?.activeVersion).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("import into a fresh install produces the same active versions", () => {
    const src = setup();
    const dst = setup();
    try {
      seedPrompt(src.db, "k1", [
        { version: 1, content: "v1" },
        { version: 2, content: "v2", active: true },
      ]);
      const yaml = serializePack(src.db);
      const pack = parsePack(yaml);
      const result = applyPack(dst.db, pack, { activateImported: false });
      expect(result.perPrompt.length).toBe(1);
      expect(result.perPrompt[0]?.added).toBe(2);
      expect(result.perPrompt[0]?.activated).toBe(true);

      const active = dst.db
        .select()
        .from(schema.prompts)
        .where(and(eq(schema.prompts.promptKey, "k1"), eq(schema.prompts.active, true)))
        .get();
      expect(active?.version).toBe(2);
      expect(active?.content).toBe("v2");
    } finally {
      src.cleanup();
      dst.cleanup();
    }
  });

  test("import then export reproduces the original (idempotent)", () => {
    const src = setup();
    const dst = setup();
    try {
      seedPrompt(src.db, "k1", [
        { version: 1, content: "v1" },
        { version: 2, content: "v2", active: true },
      ]);
      seedPrompt(src.db, "k2", [{ version: 1, content: "only", active: true }]);
      const yamlA = serializePack(src.db);
      applyPack(dst.db, parsePack(yamlA), { activateImported: false });
      const yamlB = serializePack(dst.db);

      const a = parsePack(yamlA);
      const b = parsePack(yamlB);
      expect(b.prompts.length).toBe(a.prompts.length);
      for (const ka of a.prompts) {
        const kb = b.prompts.find((p) => p.key === ka.key);
        expect(kb).toBeDefined();
        expect(kb?.activeVersion).toBe(ka.activeVersion);
        expect(kb?.versions.length).toBe(ka.versions.length);
      }
    } finally {
      src.cleanup();
      dst.cleanup();
    }
  });

  test("import with activateImported=false preserves local active version", () => {
    const dst = setup();
    try {
      // Local install has its own custom active version of k1.
      seedPrompt(dst.db, "k1", [
        { version: 1, content: "local-v1", active: true },
        { version: 2, content: "local-v2" },
      ]);
      // Pack arrives with v3 marked as activeVersion.
      const pack = parsePack(`
factoryPromptPack: 1
exportedAt: 2026-05-04T00:00:00Z
prompts:
  - key: k1
    activeVersion: 3
    versions:
      - version: 3
        body: "imported-v3"
        createdAt: 2026-05-04T00:00:00Z
`);
      const result = applyPack(dst.db, pack, { activateImported: false });
      expect(result.perPrompt[0]?.added).toBe(1);
      expect(result.perPrompt[0]?.skipped).toBe(0);
      expect(result.perPrompt[0]?.activated).toBe(false);

      const active = dst.db
        .select()
        .from(schema.prompts)
        .where(and(eq(schema.prompts.promptKey, "k1"), eq(schema.prompts.active, true)))
        .get();
      expect(active?.version).toBe(1);
      expect(active?.content).toBe("local-v1");
    } finally {
      dst.cleanup();
    }
  });

  test("import with activateImported=true overrides local active version", () => {
    const dst = setup();
    try {
      seedPrompt(dst.db, "k1", [{ version: 1, content: "local-v1", active: true }]);
      const pack = parsePack(`
factoryPromptPack: 1
exportedAt: 2026-05-04T00:00:00Z
prompts:
  - key: k1
    activeVersion: 2
    versions:
      - version: 2
        body: "imported-v2"
        createdAt: 2026-05-04T00:00:00Z
`);
      applyPack(dst.db, pack, { activateImported: true });
      const active = dst.db
        .select()
        .from(schema.prompts)
        .where(and(eq(schema.prompts.promptKey, "k1"), eq(schema.prompts.active, true)))
        .get();
      expect(active?.version).toBe(2);
      expect(active?.content).toBe("imported-v2");
    } finally {
      dst.cleanup();
    }
  });

  test("re-importing an already-imported pack is a no-op", () => {
    const dst = setup();
    try {
      const pack = parsePack(`
factoryPromptPack: 1
exportedAt: 2026-05-04T00:00:00Z
prompts:
  - key: k1
    activeVersion: 1
    versions:
      - version: 1
        body: "v1"
        createdAt: 2026-05-04T00:00:00Z
`);
      const r1 = applyPack(dst.db, pack, { activateImported: false });
      expect(r1.perPrompt[0]?.added).toBe(1);
      const r2 = applyPack(dst.db, pack, { activateImported: false });
      expect(r2.perPrompt[0]?.added).toBe(0);
      expect(r2.perPrompt[0]?.skipped).toBe(1);
    } finally {
      dst.cleanup();
    }
  });

  test("malformed YAML throws PackError(bad_yaml)", () => {
    expect(() => parsePack(":\n  - not: a: real: yaml: doc")).toThrow(PackError);
  });

  test("missing factoryPromptPack version is rejected", () => {
    expect(() => parsePack("prompts: []\n")).toThrow(PackError);
  });

  test("wrong factoryPromptPack version is rejected", () => {
    expect(() => parsePack("factoryPromptPack: 999\nprompts: []\n")).toThrow(PackError);
  });

  test("missing prompts array is rejected", () => {
    expect(() => parsePack("factoryPromptPack: 1\n")).toThrow(PackError);
  });
});
