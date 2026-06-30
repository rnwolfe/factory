import { describe, expect, test } from "bun:test";
import type { TaskFile, TaskFrontmatter } from "../src/projects/tasks.ts";
import {
  dependencyCycleExists,
  isStartable,
  normalizeBlockedBy,
  openBlockers,
  pickNextReadyTask,
  tasksById,
} from "../src/projects/tasks.ts";

function task(id: string, status: TaskFrontmatter["status"], blockedBy?: string[]): TaskFile {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    frontmatter: { id, title: id, status, ...(blockedBy ? { blockedBy } : {}) },
    body: "",
  };
}

describe("normalizeBlockedBy", () => {
  test("trims, drops empties + self, dedupes", () => {
    expect(normalizeBlockedBy([" task-1 ", "", "task-2", "task-1", "self"], "self")).toEqual([
      "task-1",
      "task-2",
    ]);
  });
  test("undefined → empty", () => {
    expect(normalizeBlockedBy(undefined)).toEqual([]);
  });
  test("caps at 50", () => {
    const many = Array.from({ length: 70 }, (_, i) => `task-${i}`);
    expect(normalizeBlockedBy(many)).toHaveLength(50);
  });
});

describe("isStartable", () => {
  test("ready with no deps → startable", () => {
    const t = task("task-1", "ready");
    expect(isStartable(t, tasksById([t]))).toBe(true);
  });
  test("ready but an open dep → not startable", () => {
    const a = task("task-1", "ready");
    const b = task("task-2", "ready", ["task-1"]);
    expect(isStartable(b, tasksById([a, b]))).toBe(false);
  });
  test("dep done → startable; dep dropped → startable", () => {
    const a = task("task-1", "done");
    const b = task("task-2", "ready", ["task-1"]);
    expect(isStartable(b, tasksById([a, b]))).toBe(true);
    const c = task("task-3", "dropped");
    const d = task("task-4", "ready", ["task-3"]);
    expect(isStartable(d, tasksById([c, d]))).toBe(true);
  });
  test("unknown dep id is treated as satisfied (never deadlocks)", () => {
    const t = task("task-2", "ready", ["task-ghost"]);
    expect(isStartable(t, tasksById([t]))).toBe(true);
  });
  test("non-ready status is never startable", () => {
    const t = task("task-1", "in_progress");
    expect(isStartable(t, tasksById([t]))).toBe(false);
  });
});

describe("openBlockers", () => {
  test("lists only the unsatisfied deps", () => {
    const a = task("task-1", "done");
    const b = task("task-2", "ready");
    const c = task("task-3", "ready", ["task-1", "task-2"]);
    expect(openBlockers(c, tasksById([a, b, c]))).toEqual(["task-2"]);
  });
});

describe("pickNextReadyTask honors dependencies", () => {
  test("skips a ready-but-gated task and the gate clears when the dep completes", () => {
    // task-2 is gated by task-1; with task-1 still ready, pick task-1 first.
    let pool = [task("task-1", "ready"), task("task-2", "ready", ["task-1"])];
    expect(pickNextReadyTask(pool, null)?.id).toBe("task-1");
    // after task-1 is done, task-2 (next after task-1) becomes startable.
    pool = [task("task-1", "done"), task("task-2", "ready", ["task-1"])];
    expect(pickNextReadyTask(pool, "task-1")?.id).toBe("task-2");
    // while task-1 is still open, advancing past it yields nothing startable.
    pool = [task("task-1", "in_progress"), task("task-2", "ready", ["task-1"])];
    expect(pickNextReadyTask(pool, "task-1")).toBeNull();
  });
});

describe("dependencyCycleExists", () => {
  test("detects a direct back-edge", () => {
    const a = task("task-1", "ready", ["task-2"]);
    const b = task("task-2", "ready");
    // setting task-2.blockedBy = [task-1] closes 1→2→1.
    expect(dependencyCycleExists(tasksById([a, b]), "task-2", ["task-1"])).toBe(true);
  });
  test("detects a transitive cycle", () => {
    const a = task("task-1", "ready", ["task-2"]);
    const b = task("task-2", "ready", ["task-3"]);
    const c = task("task-3", "ready");
    expect(dependencyCycleExists(tasksById([a, b, c]), "task-3", ["task-1"])).toBe(true);
  });
  test("acyclic addition is allowed", () => {
    const a = task("task-1", "ready");
    const b = task("task-2", "ready");
    expect(dependencyCycleExists(tasksById([a, b]), "task-2", ["task-1"])).toBe(false);
  });
});
