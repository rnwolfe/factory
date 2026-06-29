import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { payloadFor } from "../src/push/dispatcher.ts";

const cfg: FactoryConfig = {
  port: 0,
  host: "127.0.0.1",
  auth: { token: "" },
  workdir: "/tmp",
  worktreesRoot: "/tmp/wt",
  dbPath: "/tmp/db",
  maxConcurrentRuns: 1,
  defaultRunBudgetSeconds: 60,
  agentBudgetSeconds: 0,
  gitAuthor: { name: "t", email: "t@t" },
  githubToken: null,
  githubApp: null,
  factoryProjectId: null,
  githubReplyAllowlist: [],
  publicBaseUrl: null,
  notifyOnRunComplete: false,
  vapid: { publicKey: "", privateKey: "", subject: "mailto:t@t" },
};

function tempDb(): { root: string; dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-push-test-"));
  return {
    root,
    dbPath: path.join(root, "data.db"),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

interface Setup {
  db: ReturnType<typeof createDb>;
  root: string;
  cleanup: () => void;
}

function setup(): Setup {
  const { root, dbPath, cleanup } = tempDb();
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return { db, root, cleanup };
}

async function insertProject(
  db: Setup["db"],
  opts: { autonomyMode: "collaborative" | "autonomous"; name?: string; workdirPath?: string },
): Promise<string> {
  const id = createId();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id,
    slug: `proj-${id.slice(0, 6)}`,
    name: opts.name ?? "test",
    workdirPath: opts.workdirPath ?? `/tmp/${id}`,
    createdAt: now,
    lastActivityAt: now,
    ceremony: opts.autonomyMode === "autonomous" ? "tinker" : "personal",
    autonomyMode: opts.autonomyMode,
  });
  return id;
}

async function insertRun(
  db: Setup["db"],
  opts: { projectId: string; summary?: string | null; taskId?: string | null },
): Promise<string> {
  const id = createId();
  const now = Date.now();
  await db.insert(schema.runs).values({
    id,
    projectId: opts.projectId,
    status: "completed",
    branch: `factory/run-${id}`,
    worktreePath: `/tmp/wt/${id}`,
    startedAt: now,
    budgetSeconds: 60,
    summary: opts.summary ?? null,
    taskId: opts.taskId ?? null,
  });
  return id;
}

function writeTask(projectPath: string, taskId: string, title: string): void {
  const dir = path.join(projectPath, ".factory", "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${taskId}-test.md`),
    `---\nid: ${taskId}\ntitle: ${title}\nstatus: ready\n---\n\nbody\n`,
    "utf8",
  );
}

async function insertDecision(
  db: Setup["db"],
  opts: {
    kind: "agent_decision" | "blocked_run" | "merge_failure" | "triage" | "issue_intake";
    projectId: string | null;
    payload?: unknown;
    outcome?: string;
  },
): Promise<string> {
  const id = createId();
  await db.run(sql`
    insert into ${schema.decisions}
      (id, kind, project_id, outcome, payload, status, created_at)
    values
      (
        ${id},
        ${opts.kind},
        ${opts.projectId},
        ${opts.outcome ?? "decided: something"},
        ${JSON.stringify(opts.payload ?? {})},
        'pending',
        ${Date.now()}
      )
  `);
  return id;
}

describe("push dispatcher · payloadFor", () => {
  test("agent_decision is suppressed for autonomous projects", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "autonomous" });
      const decisionId = await insertDecision(db, {
        kind: "agent_decision",
        projectId,
        payload: { summary: "use postgres" },
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("agent_decision pushes for collaborative projects", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const decisionId = await insertDecision(db, {
        kind: "agent_decision",
        projectId,
        payload: { summary: "switch to postgres" },
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toContain("decision");
      expect(payload?.body).toContain("postgres");
      expect(payload?.url).toBe(`/decisions/${decisionId}`);
      expect(payload?.tag).toBe(`decision:${decisionId}`);
    } finally {
      cleanup();
    }
  });

  test("blocked_run always pushes — even on autonomous projects", async () => {
    const { db, cleanup } = setup();
    try {
      // Autonomy filter should NOT apply to involuntary stop-the-line events.
      // A blocked run is the agent giving up; the operator must see it.
      const projectId = await insertProject(db, { autonomyMode: "autonomous" });
      const decisionId = await insertDecision(db, {
        kind: "blocked_run",
        projectId,
        outcome: "agent asked: which auth provider?",
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("run blocked");
    } finally {
      cleanup();
    }
  });

  test("blocked_run body includes project, task title, status, and run id", async () => {
    const { db, root, cleanup } = setup();
    try {
      const projectPath = path.join(root, "project");
      writeTask(projectPath, "task-007", "Add contextual notifications");
      const projectId = await insertProject(db, {
        autonomyMode: "collaborative",
        name: "Factory",
        workdirPath: projectPath,
      });
      const decisionId = await insertDecision(db, {
        kind: "blocked_run",
        projectId,
        payload: {
          runId: "abcdef123456",
          taskId: "task-007",
          summary: "needs operator guidance",
        },
        outcome: "blocked",
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.body).toContain("Factory");
      expect(payload?.body).toContain("Add contextual notifications");
      expect(payload?.body).toContain("blocked");
      expect(payload?.body).toContain("run abcdef12");
      expect(payload?.body).toContain("needs operator guidance");
    } finally {
      cleanup();
    }
  });

  test("merge_failure always pushes", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "autonomous" });
      const decisionId = await insertDecision(db, {
        kind: "merge_failure",
        projectId,
        outcome: "merge conflict on schema.ts",
        payload: {
          runId: "123456789",
          taskId: "task-404",
          reason: "conflict",
          message: "schema.ts conflict",
        },
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("merge failed");
      expect(payload?.body).toContain("test");
      expect(payload?.body).toContain("task-404");
      expect(payload?.body).toContain("merge failed");
      expect(payload?.body).toContain("run 12345678");
      expect(payload?.body).toContain("schema.ts conflict");
    } finally {
      cleanup();
    }
  });

  test("issue_intake pushes a descriptive new-issue notification", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "autonomous" });
      // Autonomy filter must NOT apply: an externally-filed issue is operator
      // input, not a routine agent call, so it surfaces regardless of mode.
      const decisionId = await insertDecision(db, {
        kind: "issue_intake",
        projectId,
        outcome: "intake",
        payload: { number: 42, title: "login button is broken", author: "octocat" },
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("new GitHub issue");
      expect(payload?.body).toContain("#42");
      expect(payload?.body).toContain("login button is broken");
      expect(payload?.body).toContain("@octocat");
      expect(payload?.url).toBe(`/decisions/${decisionId}`);
      expect(payload?.tag).toBe(`decision:${decisionId}`);
    } finally {
      cleanup();
    }
  });

  test("missing decision row returns null", async () => {
    const { db, cleanup } = setup();
    try {
      const payload = await payloadFor(
        {
          channel: "inbox",
          kind: "decision_created",
          decisionId: "does-not-exist",
          projectId: null,
        },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("session_ended with merge_failed produces a push", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const payload = await payloadFor(
        {
          channel: "inbox",
          kind: "session_ended",
          sessionId: "sess-123",
          projectId,
          status: "merge_failed",
          commitCount: 2,
        },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.url).toBe(`/projects/${projectId}/sessions/sess-123`);
    } finally {
      cleanup();
    }
  });

  test("session_ended with normal status does not push", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const payload = await payloadFor(
        {
          channel: "inbox",
          kind: "session_ended",
          sessionId: "sess-123",
          projectId,
          status: "merged",
          commitCount: 2,
        },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("non-attention events return null", async () => {
    const { db, cleanup } = setup();
    try {
      const payload = await payloadFor(
        { channel: "inbox", kind: "comment_added", decisionId: "x", role: "agent" },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("run_finalized completed does not push when notifyOnRunComplete is off", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId });
      const payload = await payloadFor(
        { channel: "events", kind: "run_finalized", runId, finalStatus: "completed" },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("agent_exit never drives the run-complete push (moved to run_finalized)", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId });
      const payload = await payloadFor(
        { channel: "events", kind: "agent_exit", exitCode: 0, ts: Date.now(), runId, iteration: 1 },
        db,
        { ...cfg, notifyOnRunComplete: true },
      );
      expect(payload).toBeNull(); // agent_exit no longer pushes — fires too early
    } finally {
      cleanup();
    }
  });

  test("run_finalized completed pushes when notifyOnRunComplete is on", async () => {
    const { db, root, cleanup } = setup();
    try {
      const projectPath = path.join(root, "project");
      writeTask(projectPath, "task-009", "Add auth gate");
      const projectId = await insertProject(db, {
        autonomyMode: "collaborative",
        name: "Operator Portal",
        workdirPath: projectPath,
      });
      const runId = await insertRun(db, {
        projectId,
        summary: "added auth gate",
        taskId: "task-009",
      });
      const payload = await payloadFor(
        { channel: "events", kind: "run_finalized", runId, finalStatus: "completed" },
        db,
        { ...cfg, notifyOnRunComplete: true },
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("run complete");
      expect(payload?.body).toContain("Operator Portal");
      expect(payload?.body).toContain("Add auth gate");
      expect(payload?.body).toContain("completed");
      expect(payload?.body).toContain(`run ${runId.slice(0, 8)}`);
      expect(payload?.body).toContain("added auth gate");
      expect(payload?.url).toBe(`/projects/${projectId}/runs/${runId}`);
      expect(payload?.tag).toBe(`run:${runId}`);
    } finally {
      cleanup();
    }
  });

  test("run_finalized non-completed (held/failed) never pushes — surfaces via decision_created", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId });
      const payload = await payloadFor(
        { channel: "events", kind: "run_finalized", runId, finalStatus: "needs_review" },
        db,
        { ...cfg, notifyOnRunComplete: true },
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });
});
