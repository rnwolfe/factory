import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@factory/db";
import { organizeProjectBacklog, runImportEnrichment } from "../src/projects/import-enrich.ts";
import { createTask, readTaskFile, updateTaskStatus } from "../src/projects/tasks.ts";

const db = {} as Db; // resolveAgent is never reached when agentInvoker is injected.
const invoker = (text: string) => async () => ({ text, sessionId: null, metrics: null });

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-import-enrich-"));
  mkdirSync(path.join(root, ".factory", "work"), { recursive: true });
  const project = { workdirPath: root, taskBackend: "file" as const, id: "p1" };
  const a = await createTask(project, { title: "Foundation", body: "the base schema" });
  const b = await createTask(project, { title: "Feature", body: "depends on the schema" });
  const c = await createTask(project, { title: "Polish", body: "after the feature" });
  return { project, a, b, c, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runImportEnrichment", () => {
  test("applies inferred blockedBy edges + priority, scoped to the adopted set", async () => {
    const h = await setup();
    try {
      const json = JSON.stringify({
        tasks: [
          { id: h.a.id, priority: "high" },
          { id: h.b.id, priority: "med", blockedBy: [h.a.id] },
          { id: h.c.id, priority: "low", blockedBy: [h.b.id] },
        ],
      });
      const res = await runImportEnrichment({ db }, h.project, [h.a.id, h.b.id, h.c.id], {
        agentInvoker: invoker(`here you go\n\`\`\`json\n${json}\n\`\`\``),
      });
      expect(res.inferenceFailed).toBe(false);
      expect(res.edgesApplied).toBe(2);
      expect(res.prioritiesApplied).toBe(3);

      const b = await readTaskFile(h.project, h.b.id);
      const c = await readTaskFile(h.project, h.c.id);
      const a = await readTaskFile(h.project, h.a.id);
      expect(b?.frontmatter.blockedBy).toEqual([h.a.id]);
      expect(c?.frontmatter.blockedBy).toEqual([h.b.id]);
      expect(a?.frontmatter.priority).toBe("high");
      expect(b?.frontmatter.priority).toBe("med");
    } finally {
      h.cleanup();
    }
  });

  test("drops out-of-set ids and self-edges; ignores bad priorities", async () => {
    const h = await setup();
    try {
      const json = JSON.stringify({
        tasks: [
          // self-edge + an id outside the adopted set → both dropped, no edge left.
          { id: h.b.id, priority: "URGENT", blockedBy: [h.b.id, "task-999"] },
        ],
      });
      const res = await runImportEnrichment({ db }, h.project, [h.a.id, h.b.id], {
        agentInvoker: invoker(`\`\`\`json\n${json}\n\`\`\``),
      });
      expect(res.edgesApplied).toBe(0);
      expect(res.prioritiesApplied).toBe(0); // "URGENT" is not a valid priority
      const b = await readTaskFile(h.project, h.b.id);
      expect(b?.frontmatter.blockedBy).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("rejects a cyclic edge set (never deadlocks the queue)", async () => {
    const h = await setup();
    try {
      // a→b and b→a would cycle; the second is skipped.
      const json = JSON.stringify({
        tasks: [
          { id: h.a.id, blockedBy: [h.b.id] },
          { id: h.b.id, blockedBy: [h.a.id] },
        ],
      });
      const res = await runImportEnrichment({ db }, h.project, [h.a.id, h.b.id], {
        agentInvoker: invoker(`\`\`\`json\n${json}\n\`\`\``),
      });
      // First edge applies; the reverse is cycle-rejected.
      expect(res.edgesApplied).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("best-effort: unparseable model output leaves tasks untouched", async () => {
    const h = await setup();
    try {
      const res = await runImportEnrichment({ db }, h.project, [h.a.id, h.b.id], {
        agentInvoker: invoker("no json here, just prose"),
      });
      expect(res.inferenceFailed).toBe(true);
      expect(res.edgesApplied).toBe(0);
      const b = await readTaskFile(h.project, h.b.id);
      expect(b?.frontmatter.blockedBy).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("organizeProjectBacklog", () => {
  test("runs over open tasks only (excludes done/dropped) and applies inference", async () => {
    const h = await setup();
    try {
      // Drop C — it must be excluded from the organizable backlog.
      await updateTaskStatus(h.project, h.c.id, "dropped");
      const json = JSON.stringify({
        tasks: [
          { id: h.a.id, priority: "high" },
          { id: h.b.id, blockedBy: [h.a.id] },
          { id: h.c.id, blockedBy: [h.a.id] }, // C is terminal → not in the set, ignored
        ],
      });
      const res = await organizeProjectBacklog({ db }, h.project, {
        agentInvoker: invoker(`\`\`\`json\n${json}\n\`\`\``),
      });
      expect(res.taskCount).toBe(2); // A + B open; C dropped
      expect(res.edgesApplied).toBe(1);
      expect(res.prioritiesApplied).toBe(1);
      const b = await readTaskFile(h.project, h.b.id);
      expect(b?.frontmatter.blockedBy).toEqual([h.a.id]);
    } finally {
      h.cleanup();
    }
  });
});
