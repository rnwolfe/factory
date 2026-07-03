import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  childrenOf,
  createTask,
  isEpic,
  isStartable,
  listTasks,
  maybeAutoCloseEpics,
  subIssuesSummary,
  taskStoreFor,
  tasksById,
  updateTaskStatus,
} from "../src/projects/tasks.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-hierarchy-"));
  mkdirSync(path.join(root, ".factory", "work"), { recursive: true });
  const target = { workdirPath: root, taskBackend: "file" as const };
  return { target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("hierarchy derivation (ADR-023)", () => {
  test("childrenOf / isEpic / subIssuesSummary roll up from parent edges", async () => {
    const h = setup();
    try {
      const epic = await createTask(h.target, { title: "Epic", body: "x" });
      const c1 = await createTask(h.target, { title: "C1", body: "x" });
      const c2 = await createTask(h.target, { title: "C2", body: "x" });
      const store = taskStoreFor(h.target);
      await store.setParent(c1.id, epic.id);
      await store.setParent(c2.id, epic.id);
      await updateTaskStatus(h.target, c1.id, "done");

      const byId = tasksById(await listTasks(h.target));
      const epicTask = byId.get(epic.id)!;
      expect(isEpic(epicTask, byId)).toBe(true);
      expect(
        childrenOf(epicTask, byId)
          .map((c) => c.id)
          .sort(),
      ).toEqual([c1.id, c2.id].sort());
      expect(subIssuesSummary(epicTask, byId)).toEqual({ total: 2, completed: 1 });
      // A leaf is not an epic.
      expect(isEpic(byId.get(c1.id)!, byId)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("an epic is never startable, even when ready (it's a container)", async () => {
    const h = setup();
    try {
      const epic = await createTask(h.target, { title: "Epic", body: "x" });
      const child = await createTask(h.target, { title: "Child", body: "x" });
      const store = taskStoreFor(h.target);
      await store.setParent(child.id, epic.id);
      await updateTaskStatus(h.target, epic.id, "ready");
      await updateTaskStatus(h.target, child.id, "ready");

      const byId = tasksById(await listTasks(h.target));
      expect(isStartable(byId.get(epic.id)!, byId)).toBe(false); // container
      expect(isStartable(byId.get(child.id)!, byId)).toBe(true); // the real work
    } finally {
      h.cleanup();
    }
  });
});

describe("setParent (file backend, ADR-023)", () => {
  test("sets and clears the parent link", async () => {
    const h = setup();
    try {
      const epic = await createTask(h.target, { title: "Epic", body: "x" });
      const child = await createTask(h.target, { title: "Child", body: "x" });
      const store = taskStoreFor(h.target);

      const set = await store.setParent(child.id, epic.id);
      expect(set?.frontmatter.parent).toBe(epic.id);

      const cleared = await store.setParent(child.id, null);
      expect(cleared?.frontmatter.parent).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("rejects self-parent and cycles", async () => {
    const h = setup();
    try {
      const a = await createTask(h.target, { title: "A", body: "x" });
      const b = await createTask(h.target, { title: "B", body: "x" });
      const store = taskStoreFor(h.target);
      await store.setParent(b.id, a.id); // B under A

      expect(store.setParent(a.id, a.id)).rejects.toThrow(/own parent/);
      // A under B would close a loop (B is already under A).
      expect(store.setParent(a.id, b.id)).rejects.toThrow(/cycle/);
    } finally {
      h.cleanup();
    }
  });
});

describe("maybeAutoCloseEpics (ADR-023)", () => {
  test("closes an epic once all children are terminal; leaves a partial epic open", async () => {
    const h = setup();
    try {
      const epic = await createTask(h.target, { title: "Epic", body: "x" });
      const c1 = await createTask(h.target, { title: "C1", body: "x" });
      const c2 = await createTask(h.target, { title: "C2", body: "x" });
      const store = taskStoreFor(h.target);
      await store.setParent(c1.id, epic.id);
      await store.setParent(c2.id, epic.id);
      await updateTaskStatus(h.target, epic.id, "ready");

      // One child done — epic stays open.
      await updateTaskStatus(h.target, c1.id, "done");
      expect(await maybeAutoCloseEpics(store)).toEqual([]);
      let byId = tasksById(await listTasks(h.target));
      expect(byId.get(epic.id)!.frontmatter.status).toBe("ready");

      // Second child dropped — all terminal, epic auto-closes.
      await updateTaskStatus(h.target, c2.id, "dropped");
      expect(await maybeAutoCloseEpics(store)).toEqual([epic.id]);
      byId = tasksById(await listTasks(h.target));
      expect(byId.get(epic.id)!.frontmatter.status).toBe("done");

      // Idempotent — a second sweep closes nothing new.
      expect(await maybeAutoCloseEpics(store)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
