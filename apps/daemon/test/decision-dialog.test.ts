import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { runDecisionReply } from "../src/decisions/dialog.ts";
import { EventBus } from "../src/events.ts";

interface SeedOpts {
  kind: "blocked_run" | "agent_decision" | "triage";
  taskBackend?: "file" | "github-issues";
  payload?: Record<string, unknown>;
}

function setup(opts: SeedOpts) {
  const root = mkdtempSync(path.join(tmpdir(), "factory-decision-dialog-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  const events = new EventBus();
  const config = { githubApp: null } as unknown as FactoryConfig;
  const now = Date.now();
  const project = {
    id: "p1",
    agent: null,
    taskBackend: opts.taskBackend ?? "file",
    githubRemote:
      opts.taskBackend === "github-issues" ? "https://github.com/acme/widgets.git" : null,
    githubInstallationId: null,
  };
  db.insert(schema.projects)
    .values({
      id: "p1",
      slug: "p1",
      name: "P1",
      ceremony: "tinker",
      workdirPath: path.join(root, "p1"),
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  const decisionId = createId();
  db.insert(schema.decisions)
    .values({
      id: decisionId,
      kind: opts.kind,
      projectId: "p1",
      outcome: "x",
      payload: opts.payload ?? {},
      status: "pending",
      createdAt: now,
    })
    .run();
  return {
    db,
    events,
    config,
    project,
    decisionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function commentsFor(db: ReturnType<typeof createDb>, decisionId: string) {
  return db
    .select()
    .from(schema.decisionComments)
    .where(eq(schema.decisionComments.decisionId, decisionId))
    .orderBy(asc(schema.decisionComments.createdAt))
    .all();
}

describe("runDecisionReply — blocked_run / agent_decision dialog", () => {
  test("persists an agent reply on a blocked_run decision", async () => {
    const h = setup({
      kind: "blocked_run",
      payload: {
        runId: "r1",
        taskId: "task-003",
        summary: "stuck on auth",
        questions: ["which provider?"],
      },
    });
    try {
      // Seed the operator's answer first — the agent replies to it.
      h.db
        .insert(schema.decisionComments)
        .values({
          id: createId(),
          decisionId: h.decisionId,
          role: "operator",
          body: "use clerk",
          createdAt: Date.now(),
        })
        .run();

      const agentInvoker = async (prompt: string) => {
        // The prompt should carry the blocker context and the operator's answer.
        expect(prompt).toContain("which provider?");
        expect(prompt).toContain("use clerk");
        return {
          text: "Got it — Clerk unblocks me. I'll wire it on the retry.",
          sessionId: null,
          metrics: null,
        };
      };
      const res = await runDecisionReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        { agentInvoker, skipGithubEcho: true },
      );
      expect(res.errorMessage).toBeNull();

      const comments = commentsFor(h.db, h.decisionId);
      expect(comments.map((c) => c.role)).toEqual(["operator", "agent"]);
      expect(comments[1]?.body).toContain("Clerk unblocks me");
    } finally {
      h.cleanup();
    }
  });

  test("persists an agent reply on an agent_decision decision", async () => {
    const h = setup({
      kind: "agent_decision",
      payload: {
        runId: "r1",
        taskId: "task-004",
        summary: "picked tailwind",
        decided: "use tailwind",
        reasoning: "fastest to ship",
        options: [
          { title: "tailwind", tradeoff: "utility soup", chosen: true },
          { title: "vanilla css" },
        ],
      },
    });
    try {
      const agentInvoker = async (prompt: string) => {
        expect(prompt).toContain("use tailwind");
        expect(prompt).toContain("vanilla css");
        return {
          text: "I chose Tailwind for speed; happy to switch if you prefer vanilla.",
          sessionId: null,
          metrics: null,
        };
      };
      const res = await runDecisionReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        { agentInvoker, skipGithubEcho: true },
      );
      expect(res.errorMessage).toBeNull();
      const comments = commentsFor(h.db, h.decisionId);
      expect(comments.length).toBe(1);
      expect(comments[0]?.role).toBe("agent");
    } finally {
      h.cleanup();
    }
  });

  test("github-backed echo is a safe no-op when the App is unconfigured", async () => {
    const h = setup({
      kind: "blocked_run",
      taskBackend: "github-issues",
      payload: { runId: "r1", taskId: "42", summary: "stuck", questions: [] },
    });
    try {
      const agentInvoker = async () => ({ text: "on it", sessionId: null, metrics: null });
      // skipGithubEcho omitted → echo path runs; githubApp:null makes it no-op.
      const res = await runDecisionReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        { agentInvoker },
      );
      expect(res.errorMessage).toBeNull();
      expect(commentsFor(h.db, h.decisionId).length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("refuses kinds it does not handle", async () => {
    const h = setup({ kind: "triage" });
    try {
      const res = await runDecisionReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        {
          agentInvoker: async () => ({ text: "x", sessionId: null, metrics: null }),
          skipGithubEcho: true,
        },
      );
      expect(res.errorMessage).toContain("does not handle");
      expect(commentsFor(h.db, h.decisionId).length).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
