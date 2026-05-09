import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import {
  archiveProject,
  deleteProject,
  LifecycleError,
  unarchiveProject,
} from "../src/projects/lifecycle.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-lifecycle-test-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "test", email: "t@t" },
    githubToken: null,
    factoryProjectId: null,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function seedProject(db: ReturnType<typeof createDb>, workdirPath: string, slug = "demo"): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return id;
}

describe("project lifecycle", () => {
  test("archive flips tag=past + archivedAt", () => {
    const h = setupHarness();
    try {
      const id = seedProject(h.db, path.join(h.root, "projects", "demo"));
      archiveProject(h.db, id);
      const row = h.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
      expect(row?.tag).toBe("past");
      expect(row?.archivedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("unarchive flips back to active", () => {
    const h = setupHarness();
    try {
      const id = seedProject(h.db, path.join(h.root, "projects", "demo"));
      archiveProject(h.db, id);
      unarchiveProject(h.db, id);
      const row = h.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
      expect(row?.tag).toBe("active");
      expect(row?.archivedAt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("archiveProject on missing id throws LifecycleError", () => {
    const h = setupHarness();
    try {
      expect(() => archiveProject(h.db, "nonexistent")).toThrow(LifecycleError);
    } finally {
      h.cleanup();
    }
  });

  test("delete cascades runs, audits, plans, decisions, and their child rows", async () => {
    const h = setupHarness();
    try {
      const workdir = path.join(h.root, "projects", "demo");
      mkdirSync(workdir, { recursive: true });
      writeFileSync(path.join(workdir, "README.md"), "# demo\n");
      const projectId = seedProject(h.db, workdir);

      const runId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: runId,
          projectId,
          taskId: null,
          status: "completed",
          agentName: "claude-code",
          branch: "main",
          worktreePath: path.join(h.config.worktreesRoot, "demo", runId),
          tmuxSession: null,
          sessionId: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
          exitCode: 0,
          iterationCount: 1,
          budgetSeconds: 60,
        })
        .run();
      h.db
        .insert(schema.events)
        .values({
          runId,
          iteration: 1,
          ts: Date.now(),
          kind: "run.completed",
          payload: {},
        })
        .run();

      const auditId = createId();
      h.db
        .insert(schema.audits)
        .values({
          id: auditId,
          projectId,
          skillName: "x",
          skillVersion: "abc",
          status: "completed",
          startedAt: Date.now(),
          completedAt: Date.now(),
          findings: null,
        })
        .run();
      h.db
        .insert(schema.auditComments)
        .values({
          id: createId(),
          auditId,
          role: "operator",
          body: "hi",
          createdAt: Date.now(),
        })
        .run();

      const planId = createId();
      h.db
        .insert(schema.plans)
        .values({
          id: planId,
          kind: "task_plan",
          status: "drafting",
          projectId,
          taskId: null,
          goal: "g",
          draft: "{}",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      h.db
        .insert(schema.planComments)
        .values({
          id: createId(),
          planId,
          role: "operator",
          body: "x",
          createdAt: Date.now(),
        })
        .run();

      const decisionId = createId();
      h.db
        .insert(schema.decisions)
        .values({
          id: decisionId,
          kind: "tag_change",
          projectId,
          outcome: "tag:past",
          payload: {},
          status: "pending",
          createdAt: Date.now(),
        })
        .run();
      h.db
        .insert(schema.decisionComments)
        .values({
          id: createId(),
          decisionId,
          role: "operator",
          body: "ok",
          createdAt: Date.now(),
        })
        .run();

      h.db
        .insert(schema.claudeMetrics)
        .values({
          id: createId(),
          ownerKind: "run",
          ownerId: runId,
          projectId,
          model: null,
          modelUsage: null,
          totalCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          isError: false,
          createdAt: Date.now(),
        })
        .run();

      // Pre-flight count.
      expect(h.db.select({ id: schema.runs.id }).from(schema.runs).all().length).toBe(1);
      expect(h.db.select({ id: schema.audits.id }).from(schema.audits).all().length).toBe(1);

      const result = await deleteProject(h.config, h.db, projectId, { removeWorkdir: true });

      // All scoped tables empty.
      expect(h.db.select({ id: schema.runs.id }).from(schema.runs).all().length).toBe(0);
      expect(h.db.select({ id: schema.audits.id }).from(schema.audits).all().length).toBe(0);
      expect(
        h.db.select({ id: schema.auditComments.id }).from(schema.auditComments).all().length,
      ).toBe(0);
      expect(h.db.select({ id: schema.plans.id }).from(schema.plans).all().length).toBe(0);
      expect(
        h.db.select({ id: schema.planComments.id }).from(schema.planComments).all().length,
      ).toBe(0);
      expect(h.db.select({ id: schema.decisions.id }).from(schema.decisions).all().length).toBe(0);
      expect(
        h.db.select({ id: schema.decisionComments.id }).from(schema.decisionComments).all().length,
      ).toBe(0);
      expect(h.db.select({ id: schema.events.id }).from(schema.events).all().length).toBe(0);
      expect(
        h.db.select({ id: schema.claudeMetrics.id }).from(schema.claudeMetrics).all().length,
      ).toBe(0);
      expect(h.db.select({ id: schema.projects.id }).from(schema.projects).all().length).toBe(0);

      // Result counts are non-zero where we inserted rows.
      expect(result.removedRows.runs).toBe(1);
      expect(result.removedRows.audits).toBe(1);
      expect(result.removedRows.events).toBe(1);
      expect(result.removedRows.metrics).toBeGreaterThanOrEqual(1);
      expect(result.removedWorkdir).toBe(true);

      // Workdir gone.
      expect(existsSync(workdir)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("delete refuses while a run is running", async () => {
    const h = setupHarness();
    try {
      const workdir = path.join(h.root, "projects", "demo");
      mkdirSync(workdir, { recursive: true });
      const projectId = seedProject(h.db, workdir);
      const runId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: runId,
          projectId,
          taskId: null,
          status: "running",
          agentName: "claude-code",
          branch: "main",
          worktreePath: path.join(h.config.worktreesRoot, "demo", runId),
          tmuxSession: null,
          sessionId: null,
          startedAt: Date.now(),
          endedAt: null,
          exitCode: null,
          iterationCount: 0,
          budgetSeconds: 60,
        })
        .run();

      try {
        await deleteProject(h.config, h.db, projectId, { removeWorkdir: false });
        throw new Error("expected LifecycleError");
      } catch (err) {
        expect(err).toBeInstanceOf(LifecycleError);
        expect((err as LifecycleError).code).toBe("running_run");
      }
    } finally {
      h.cleanup();
    }
  });

  test("delete with removeWorkdir=true on a path-imported (outside factory root) workdir does NOT remove it", async () => {
    const h = setupHarness();
    try {
      const externalRoot = mkdtempSync(path.join(tmpdir(), "factory-external-"));
      try {
        const workdir = path.join(externalRoot, "imported-repo");
        mkdirSync(workdir, { recursive: true });
        writeFileSync(path.join(workdir, "README.md"), "# imported\n");
        const projectId = seedProject(h.db, workdir, "imported");

        const result = await deleteProject(h.config, h.db, projectId, { removeWorkdir: true });
        expect(result.removedWorkdir).toBe(false);
        expect(existsSync(workdir)).toBe(true);
        expect(existsSync(path.join(workdir, "README.md"))).toBe(true);
      } finally {
        rmSync(externalRoot, { recursive: true, force: true });
      }
    } finally {
      h.cleanup();
    }
  });
});
