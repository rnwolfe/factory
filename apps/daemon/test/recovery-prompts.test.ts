import { describe, expect, test } from "bun:test";
import { createDb, runMigrations } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInterventionPrompt } from "../src/recovery-prompts/prompts.ts";

interface Harness {
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
}

function mkHarness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-rp-test-"));
  const dbPath = path.join(dir, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function seedProjectAndRun(
  db: ReturnType<typeof createDb>,
  workdirPath: string,
): Promise<{ projectId: string; runId: string }> {
  const projectId = createId();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "test-project",
    name: "Test Project",
    workdirPath,
    createdAt: now,
    lastActivityAt: now,
  });
  const runId = createId();
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId: "task-001",
    status: "blocked",
    branch: `factory/run-${runId}`,
    worktreePath: `${workdirPath}/worktrees/${runId}`,
    startedAt: now,
    budgetSeconds: 0,
    baseRef: "abc1234",
    agentName: "claude-code",
    summary: "Made some progress; stuck on auth.",
  });
  return { projectId, runId };
}

describe("buildInterventionPrompt", () => {
  test("renders the failed-run scenario when payload.failed=true", async () => {
    const h = mkHarness();
    try {
      const { projectId, runId } = await seedProjectAndRun(h.db, "/tmp/proj-fake");
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId,
        outcome: "blocked",
        payload: { runId, branch: `factory/run-${runId}`, failed: true, summary: "agent died" },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result).not.toBeNull();
      expect(result?.scenario).toBe("blocked_run_failed");
      expect(result?.prompt).toContain("ended without emitting");
      expect(result?.prompt).toContain(runId);
      expect(result?.prompt).toContain(`factory/run-${runId}`);
      expect(result?.prompt).toContain("Test Project");
    } finally {
      h.cleanup();
    }
  });

  test("renders the blocked-with-questions scenario when failed is unset", async () => {
    const h = mkHarness();
    try {
      const { projectId, runId } = await seedProjectAndRun(h.db, "/tmp/proj-fake-q");
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId,
        outcome: "blocked",
        payload: {
          runId,
          questions: ["Which auth scheme should we use?", "Bearer or HMAC?"],
          summary: "stuck on auth",
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result?.scenario).toBe("blocked_run_questions");
      expect(result?.prompt).toContain("Which auth scheme should we use?");
      expect(result?.prompt).toContain("Bearer or HMAC?");
    } finally {
      h.cleanup();
    }
  });

  test("renders the merge-failure-dirty scenario", async () => {
    const h = mkHarness();
    try {
      const { projectId, runId } = await seedProjectAndRun(h.db, "/tmp/proj-fake-m");
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "merge_failure",
        projectId,
        outcome: "merge:dirty",
        payload: {
          runId,
          branch: `factory/run-${runId}`,
          reason: "dirty",
          message: "project working tree has uncommitted changes",
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result?.scenario).toBe("merge_failure_dirty");
      expect(result?.prompt).toContain("auto-merge into main refused");
      expect(result?.prompt).toContain("uncommitted changes");
      expect(result?.prompt).toContain("/tmp/proj-fake-m");
    } finally {
      h.cleanup();
    }
  });

  test("renders the merge-failure-conflict scenario and extracts file paths", async () => {
    const h = mkHarness();
    try {
      const { projectId, runId } = await seedProjectAndRun(h.db, "/tmp/proj-fake-c");
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "merge_failure",
        projectId,
        outcome: "merge:conflict",
        payload: {
          runId,
          branch: `factory/run-${runId}`,
          reason: "conflict",
          message: "CONFLICT (content): Merge conflict in src/foo.ts\nMerge conflict in src/bar.md",
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result?.scenario).toBe("merge_failure_conflict");
      expect(result?.prompt).toContain("src/foo.ts");
      expect(result?.prompt).toContain("src/bar.md");
    } finally {
      h.cleanup();
    }
  });

  test("returns null for decision kinds that don't need a prompt", async () => {
    const h = mkHarness();
    try {
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "tag_change",
        projectId: null,
        outcome: "tag:active",
        payload: { previousTag: "inactive", newTag: "active" },
        status: "actioned",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null for an unknown decision id", async () => {
    const h = mkHarness();
    try {
      const result = await buildInterventionPrompt(h.db, "does-not-exist");
      expect(result).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("usage-cap variant gets its own scenario", async () => {
    const h = mkHarness();
    try {
      const { projectId, runId } = await seedProjectAndRun(h.db, "/tmp/proj-fake-uc");
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "blocked_run",
        projectId,
        outcome: "blocked",
        payload: {
          runId,
          usageCapped: true,
          message: "Hit the 5-hour usage cap; resets at 4pm UTC",
          summary: "paused at iteration 1",
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await buildInterventionPrompt(h.db, decisionId);
      expect(result?.scenario).toBe("blocked_run_usage_capped");
      expect(result?.prompt).toContain("usage cap");
    } finally {
      h.cleanup();
    }
  });
});
