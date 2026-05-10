import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
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
  factoryProjectId: null,
  notifyOnRunComplete: false,
  vapid: { publicKey: "", privateKey: "", subject: "mailto:t@t" },
};

function tempDb(): { dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-push-test-"));
  return {
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
  cleanup: () => void;
}

function setup(): Setup {
  const { dbPath, cleanup } = tempDb();
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return { db, cleanup };
}

async function insertProject(
  db: Setup["db"],
  opts: { autonomyMode: "collaborative" | "autonomous" },
): Promise<string> {
  const id = createId();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id,
    slug: `proj-${id.slice(0, 6)}`,
    name: "test",
    workdirPath: `/tmp/${id}`,
    createdAt: now,
    lastActivityAt: now,
    ceremony: opts.autonomyMode === "autonomous" ? "tinker" : "personal",
    autonomyMode: opts.autonomyMode,
  });
  return id;
}

async function insertRun(
  db: Setup["db"],
  opts: { projectId: string; summary?: string | null },
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
  });
  return id;
}

async function insertDecision(
  db: Setup["db"],
  opts: {
    kind: "agent_decision" | "blocked_run" | "merge_failure" | "triage";
    projectId: string | null;
    payload?: unknown;
    outcome?: string;
  },
): Promise<string> {
  const id = createId();
  await db.insert(schema.decisions).values({
    id,
    kind: opts.kind,
    projectId: opts.projectId,
    outcome: opts.outcome ?? "decided: something",
    payload: opts.payload ?? {},
    status: "pending",
    createdAt: Date.now(),
  });
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

  test("merge_failure always pushes", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "autonomous" });
      const decisionId = await insertDecision(db, {
        kind: "merge_failure",
        projectId,
        outcome: "merge conflict on schema.ts",
      });
      const payload = await payloadFor(
        { channel: "inbox", kind: "decision_created", decisionId, projectId },
        db,
        cfg,
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("merge failed");
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

  test("agent_exit success does not push when notifyOnRunComplete is off", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId });
      const payload = await payloadFor(
        {
          channel: "events",
          kind: "agent_exit",
          exitCode: 0,
          ts: Date.now(),
          runId,
          iteration: 1,
        },
        db,
        cfg,
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("agent_exit success pushes when notifyOnRunComplete is on", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId, summary: "added auth gate" });
      const payload = await payloadFor(
        {
          channel: "events",
          kind: "agent_exit",
          exitCode: 0,
          ts: Date.now(),
          runId,
          iteration: 1,
        },
        db,
        { ...cfg, notifyOnRunComplete: true },
      );
      expect(payload).not.toBeNull();
      expect(payload?.title).toBe("run complete");
      expect(payload?.body).toContain("added auth gate");
      expect(payload?.url).toBe(`/projects/${projectId}/runs/${runId}`);
      expect(payload?.tag).toBe(`run:${runId}`);
    } finally {
      cleanup();
    }
  });

  test("agent_exit non-zero never pushes — failures land via decision_created", async () => {
    const { db, cleanup } = setup();
    try {
      const projectId = await insertProject(db, { autonomyMode: "collaborative" });
      const runId = await insertRun(db, { projectId });
      const payload = await payloadFor(
        {
          channel: "events",
          kind: "agent_exit",
          exitCode: 1,
          ts: Date.now(),
          runId,
          iteration: 1,
        },
        db,
        { ...cfg, notifyOnRunComplete: true },
      );
      expect(payload).toBeNull();
    } finally {
      cleanup();
    }
  });
});
