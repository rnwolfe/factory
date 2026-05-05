import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { RubricValidationError, validateRubricYaml } from "../src/rubrics/validate.ts";

interface Harness {
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
}

function setup(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-rubric-test-"));
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

const SAMPLE_YAML = `id: test-rubric
version: 1
axes:
  - id: utility
    weight: 1.0
    prompt: |
      Score 0-10.
agent_invocation:
  prompt_key: test-prompt
`;

describe("rubric validate", () => {
  test("parses a minimal valid rubric", () => {
    const parsed = validateRubricYaml(SAMPLE_YAML);
    expect(parsed.axes.length).toBe(1);
    expect(parsed.axes[0]?.id).toBe("utility");
    expect(parsed.promptKey).toBe("test-prompt");
  });

  test("rejects malformed yaml", () => {
    expect(() => validateRubricYaml(":\n  - not: a: real: yaml")).toThrow(RubricValidationError);
  });

  test("rejects rubric without axes", () => {
    expect(() => validateRubricYaml("id: x\nversion: 1\n")).toThrow(RubricValidationError);
  });

  test("rejects axis missing required field", () => {
    const yaml = `id: x
axes:
  - id: utility
    weight: 1.0
`;
    expect(() => validateRubricYaml(yaml)).toThrow(RubricValidationError);
  });

  test("rejects array as top-level", () => {
    expect(() => validateRubricYaml("- foo\n- bar")).toThrow(RubricValidationError);
  });
});

describe("rubric router (direct DB)", () => {
  test("upsertVersion + activateVersion atomically swap active", async () => {
    const h = setup();
    try {
      // Seed initial v1.
      const v1Id = createId();
      h.db
        .insert(schema.rubricVersions)
        .values({
          id: v1Id,
          rubricKey: "test",
          version: 1,
          parentVersionId: null,
          yaml: SAMPLE_YAML,
          promptKey: "test-prompt",
          active: true,
          createdAt: Date.now(),
        })
        .run();

      // Simulate upsertVersion: parse the yaml, insert v2 inactive.
      const v2Yaml = SAMPLE_YAML.replace("weight: 1.0", "weight: 0.5");
      const v2Id = createId();
      h.db
        .insert(schema.rubricVersions)
        .values({
          id: v2Id,
          rubricKey: "test",
          version: 2,
          parentVersionId: v1Id,
          yaml: v2Yaml,
          promptKey: "test-prompt",
          active: false,
          createdAt: Date.now(),
        })
        .run();

      // Both rows exist.
      const all = h.db
        .select()
        .from(schema.rubricVersions)
        .where(eq(schema.rubricVersions.rubricKey, "test"))
        .all();
      expect(all.length).toBe(2);

      // Active is still v1.
      const active = h.db
        .select()
        .from(schema.rubricVersions)
        .where(
          and(eq(schema.rubricVersions.rubricKey, "test"), eq(schema.rubricVersions.active, true)),
        )
        .all();
      expect(active.length).toBe(1);
      expect(active[0]?.version).toBe(1);

      // Now activate v2 atomically (simulating the router's transaction).
      h.db.transaction((tx) => {
        tx.update(schema.rubricVersions)
          .set({ active: false })
          .where(
            and(
              eq(schema.rubricVersions.rubricKey, "test"),
              eq(schema.rubricVersions.active, true),
            ),
          )
          .run();
        tx.update(schema.rubricVersions)
          .set({ active: true })
          .where(eq(schema.rubricVersions.id, v2Id))
          .run();
      });

      // Exactly one active row, and it's v2.
      const finalActive = h.db
        .select()
        .from(schema.rubricVersions)
        .where(
          and(eq(schema.rubricVersions.rubricKey, "test"), eq(schema.rubricVersions.active, true)),
        )
        .all();
      expect(finalActive.length).toBe(1);
      expect(finalActive[0]?.version).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});
