import { describe, expect, it } from "bun:test";
import { resolveTaskWithPool, type TaskFile } from "../src/projects/tasks.ts";

/** Minimal TaskFile factory for the resolver's dependency-derivation inputs. */
function task(id: string, blockedBy: string[] = []): TaskFile {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    frontmatter: { id, title: `task ${id}`, status: "ready", blockedBy },
    body: "",
  };
}

type Store = Parameters<typeof resolveTaskWithPool>[0];

/**
 * Regression coverage for the "promote → dropped on a nonexistent task route"
 * bug: a github-issues-backed `list()` can transiently fail or lag right after a
 * just-created issue. `resolveTaskWithPool` must not report a present task as
 * absent — it falls back to a direct `read()` and only returns null when the
 * task is genuinely gone.
 */
describe("resolveTaskWithPool", () => {
  it("returns the task from the pool when list() includes it", async () => {
    const t = task("86");
    let reads = 0;
    const store: Store = {
      list: async () => [task("85"), t, task("87")],
      read: async () => {
        reads++;
        return null;
      },
    };
    const res = await resolveTaskWithPool(store, "86");
    expect(res?.task.id).toBe("86");
    expect(res?.pool.map((p) => p.id)).toEqual(["85", "86", "87"]);
    // No direct read needed on the happy path.
    expect(reads).toBe(0);
  });

  it("falls back to read() when list() throws (transient backend failure)", async () => {
    const t = task("86");
    const store: Store = {
      list: async () => {
        throw new Error("502 Bad Gateway");
      },
      read: async (id) => (id === "86" ? t : null),
    };
    const res = await resolveTaskWithPool(store, "86");
    expect(res?.task.id).toBe("86");
    // Pool unavailable → best-effort empty, dependency context degrades but the
    // task still resolves (never a false "not found").
    expect(res?.pool).toEqual([]);
  });

  it("falls back to read() when list() succeeds but lags the just-created task", async () => {
    const t = task("88");
    const store: Store = {
      list: async () => [task("85"), task("86")], // 88 not propagated yet
      read: async (id) => (id === "88" ? t : null),
    };
    const res = await resolveTaskWithPool(store, "88");
    expect(res?.task.id).toBe("88");
    // The successful (if stale) pool is still carried for dependency derivation.
    expect(res?.pool.map((p) => p.id)).toEqual(["85", "86"]);
  });

  it("returns null only when the task is genuinely absent (read() 404s)", async () => {
    const store: Store = {
      list: async () => [task("85")],
      read: async () => null,
    };
    expect(await resolveTaskWithPool(store, "999")).toBeNull();
  });

  it("propagates a transient read() failure so the caller can retry, not 'not found'", async () => {
    const store: Store = {
      list: async () => {
        throw new Error("502 Bad Gateway");
      },
      read: async () => {
        throw new Error("503 Service Unavailable");
      },
    };
    // Both legs transiently down → reject (client shows a retry state), rather
    // than silently resolving null (which would render a false "task not found").
    expect(resolveTaskWithPool(store, "86")).rejects.toThrow("503");
  });
});
