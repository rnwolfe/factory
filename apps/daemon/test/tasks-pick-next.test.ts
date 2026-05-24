import { describe, expect, test } from "bun:test";
import { pickNextReadyTask, type TaskFile } from "../src/projects/tasks.ts";

function task(id: string, status: TaskFile["frontmatter"]["status"]): TaskFile {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    body: "",
    frontmatter: { id, title: id, status },
  };
}

describe("pickNextReadyTask", () => {
  test("after completing task-009, picks task-010 not task-001", () => {
    // The bug this guards against: tasks 001-008 still ready (operator
    // skipped them), 009 just finished, 010-012 ready. Original
    // implementation returned task-001 because it picked the first
    // ready task overall.
    const tasks = [
      task("task-001", "ready"),
      task("task-002", "ready"),
      task("task-008", "ready"),
      task("task-009", "done"),
      task("task-010", "ready"),
      task("task-011", "ready"),
    ];
    expect(pickNextReadyTask(tasks, "task-009")?.id).toBe("task-010");
  });

  test("skips later non-ready tasks until it finds a ready one", () => {
    const tasks = [
      task("task-009", "done"),
      task("task-010", "done"),
      task("task-011", "blocked"),
      task("task-012", "ready"),
    ];
    expect(pickNextReadyTask(tasks, "task-009")?.id).toBe("task-012");
  });

  test("returns null when nothing later is ready (does not wrap)", () => {
    // Wrap-back would silently undo the operator's "start at 009" intent.
    // Better to stop and let them pick an earlier task manually.
    const tasks = [
      task("task-001", "ready"),
      task("task-002", "ready"),
      task("task-009", "done"),
      task("task-010", "done"),
    ];
    expect(pickNextReadyTask(tasks, "task-009")).toBeNull();
  });

  test("falls back to first ready when justFinishedId is null", () => {
    // Ad-hoc submissions without a task id (rare; preserved for
    // back-compat).
    const tasks = [task("task-001", "ready"), task("task-002", "ready")];
    expect(pickNextReadyTask(tasks, null)?.id).toBe("task-001");
    expect(pickNextReadyTask(tasks, undefined)?.id).toBe("task-001");
  });

  test("falls back to first ready when justFinishedId is unknown", () => {
    // The recorded id doesn't match any task on disk (renamed, deleted) —
    // don't strand auto-advance; pick the earliest ready as a best-effort
    // continuation.
    const tasks = [task("task-001", "ready"), task("task-002", "ready")];
    expect(pickNextReadyTask(tasks, "task-deleted")?.id).toBe("task-001");
  });

  test("returns null when no tasks are ready", () => {
    const tasks = [task("task-001", "done"), task("task-002", "blocked")];
    expect(pickNextReadyTask(tasks, null)).toBeNull();
    expect(pickNextReadyTask(tasks, "task-001")).toBeNull();
  });
});
