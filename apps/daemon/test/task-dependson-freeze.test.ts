import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyDependsOnEdges,
  coerceDependsOnIndices,
  createTask,
  listTasks,
  type TaskTarget,
} from "../src/projects/tasks.ts";

function setup(): { target: TaskTarget; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "dependson-"));
  mkdirSync(path.join(root, ".factory", "work"), { recursive: true });
  return {
    target: { workdirPath: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function makeBatch(target: TaskTarget, n: number) {
  const created = [];
  for (let i = 0; i < n; i += 1) {
    created.push(await createTask(target, { title: `step ${i}`, body: "## Notes\n\nx" }));
  }
  return created;
}

describe("coerceDependsOnIndices", () => {
  test("keeps non-negative integers, drops junk, empty → undefined", () => {
    expect(coerceDependsOnIndices([0, 1, 2])).toEqual([0, 1, 2]);
    expect(coerceDependsOnIndices([0, -1, 1.5, "x", 2])).toEqual([0, 2]);
    expect(coerceDependsOnIndices([])).toBeUndefined();
    expect(coerceDependsOnIndices("nope")).toBeUndefined();
  });
});

describe("applyDependsOnEdges (file backend, end-to-end)", () => {
  test("resolves draft indices into real blockedBy edges and persists them", async () => {
    const { target, cleanup } = setup();
    try {
      const created = await makeBatch(target, 3);
      const [t0, t1, t2] = created;
      if (!t0 || !t1 || !t2) throw new Error("batch under-created");
      // step1 depends on step0; step2 depends on step1 — a chain.
      await applyDependsOnEdges(target, created, [undefined, [0], [1]]);

      const tasks = await listTasks(target);
      const byTitle = new Map(tasks.map((t) => [t.frontmatter.title, t]));
      expect(byTitle.get("step 0")?.frontmatter.blockedBy).toBeUndefined();
      expect(byTitle.get("step 1")?.frontmatter.blockedBy).toEqual([t0.id]);
      expect(byTitle.get("step 2")?.frontmatter.blockedBy).toEqual([t1.id]);
    } finally {
      cleanup();
    }
  });

  test("a no-dependsOn batch stays parallel (no edges written)", async () => {
    const { target, cleanup } = setup();
    try {
      const created = await makeBatch(target, 2);
      await applyDependsOnEdges(target, created, [undefined, undefined]);
      const tasks = await listTasks(target);
      for (const t of tasks) expect(t.frontmatter.blockedBy).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a cyclic edge set is skipped, not persisted", async () => {
    const { target, cleanup } = setup();
    try {
      const created = await makeBatch(target, 2);
      // step0 depends on step1 AND step1 depends on step0 → the second edge cycles.
      await applyDependsOnEdges(target, created, [[1], [0]]);
      const tasks = await listTasks(target);
      const withEdges = tasks.filter((t) => (t.frontmatter.blockedBy ?? []).length > 0);
      // At most one of the two edges can be applied without forming a cycle.
      expect(withEdges.length).toBeLessThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  test("out-of-range indices are dropped (never deadlock)", async () => {
    const { target, cleanup } = setup();
    try {
      const created = await makeBatch(target, 2);
      await applyDependsOnEdges(target, created, [undefined, [9]]); // index 9 doesn't exist
      const tasks = await listTasks(target);
      for (const t of tasks) expect(t.frontmatter.blockedBy).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
