import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask, listTasks, readTaskFile, reorderTask } from "../src/projects/tasks.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-task-order-"));
  mkdirSync(path.join(root, ".factory", "work"), { recursive: true });
  const target = { workdirPath: root, taskBackend: "file" as const };
  return { target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("createTask ranking is lazy (ADR-021)", () => {
  test("new tasks carry no rank and list in id (creation) order", async () => {
    const h = setup();
    try {
      const a = await createTask(h.target, { title: "A", body: "x" });
      await createTask(h.target, { title: "B", body: "x" });
      await createTask(h.target, { title: "C", body: "x" });
      // No extra list()/rank write on the create hot path.
      expect(a.frontmatter.rank).toBeUndefined();
      const list = await listTasks(h.target);
      expect(list.map((t) => t.frontmatter.title)).toEqual(["A", "B", "C"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("reorderTask (ADR-021)", () => {
  test("moving the last task to the front reorders the queue with one write", async () => {
    const h = setup();
    try {
      const a = await createTask(h.target, { title: "A", body: "x" });
      await createTask(h.target, { title: "B", body: "x" });
      const c = await createTask(h.target, { title: "C", body: "x" });

      // Move C to the head (before A, after nothing).
      await reorderTask(h.target, c.id, null, a.id);
      const list = await listTasks(h.target);
      expect(list.map((t) => t.frontmatter.title)).toEqual(["C", "A", "B"]);

      // C now sorts before A: it got a rank, and A was seeded one as the neighbor.
      const cAfter = await readTaskFile(h.target, c.id);
      const aAfter = await readTaskFile(h.target, a.id);
      expect(cAfter?.frontmatter.rank).toBeDefined();
      expect(aAfter?.frontmatter.rank).toBeDefined();
      expect(cAfter!.frontmatter.rank! < aAfter!.frontmatter.rank!).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("moving a task between two neighbors lands it strictly between", async () => {
    const h = setup();
    try {
      const a = await createTask(h.target, { title: "A", body: "x" });
      const b = await createTask(h.target, { title: "B", body: "x" });
      const c = await createTask(h.target, { title: "C", body: "x" });
      // Move A to sit between B and C.
      await reorderTask(h.target, a.id, b.id, c.id);
      const list = await listTasks(h.target);
      expect(list.map((t) => t.frontmatter.title)).toEqual(["B", "A", "C"]);
    } finally {
      h.cleanup();
    }
  });
});
