import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { BOT_COMMENT_MARKER, runIssueIntakeReply } from "../src/github/issue-triage.ts";
import { classifyWebhook, type GithubWebhookPayload } from "../src/github/webhook.ts";

const PROJECTS = [
  {
    id: "p-int",
    githubRemote: "https://github.com/rnwolfe/integrated.git",
    taskBackend: "github-issues",
  },
];

function commentPayload(over: Partial<GithubWebhookPayload> = {}): GithubWebhookPayload {
  return {
    action: "created",
    repository: { full_name: "rnwolfe/integrated" },
    issue: { number: 7 },
    comment: { body: "any update?", user: { login: "alice" } },
    ...over,
  };
}

describe("classifyWebhook — task-048 additions", () => {
  test("intake carries the issue body", () => {
    const r = classifyWebhook(
      "issues",
      {
        action: "opened",
        repository: { full_name: "rnwolfe/integrated" },
        issue: { number: 9, title: "Bug", body: "it crashes", user: { login: "alice" } },
      },
      PROJECTS,
    );
    expect(r.intake?.body).toBe("it crashes");
  });

  test("inbound human comment is classified with the comment payload", () => {
    const r = classifyWebhook("issue_comment", commentPayload(), PROJECTS);
    expect(r.status).toBe("processed");
    expect(r.comment).toEqual({ number: 7, author: "alice", body: "any update?" });
  });

  test("loop guard: a [bot]-authored comment is ignored", () => {
    const r = classifyWebhook(
      "issue_comment",
      commentPayload({ comment: { body: "reply", user: { login: "factory[bot]" } } }),
      PROJECTS,
    );
    expect(r.status).toBe("ignored");
  });

  test("loop guard: a comment carrying the bot marker is ignored", () => {
    const r = classifyWebhook(
      "issue_comment",
      commentPayload({ comment: { body: `echo\n\n${BOT_COMMENT_MARKER}`, user: { login: "x" } } }),
      PROJECTS,
    );
    expect(r.status).toBe("ignored");
  });
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-issue-triage-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  const events = new EventBus();
  const config = { githubApp: null } as unknown as FactoryConfig;
  const project = { id: "p1", agent: null, taskBackend: "file", githubRemote: null };
  const now = Date.now();
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
      kind: "issue_intake",
      projectId: "p1",
      outcome: "intake",
      payload: { number: 12, title: "Add dark mode", author: "alice", body: "please" },
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

describe("runIssueIntakeReply — auto-triage parity", () => {
  test("persists an agent comment and mirrors the draft onto the decision", async () => {
    const h = setup();
    try {
      const agentInvoker = async () => ({
        text: 'I read it as a single feature.\n\n```json\n{"kind":"task","title":"Dark mode toggle","summary":"add a toggle","reasoning":"discrete change"}\n```',
        sessionId: null,
        metrics: null,
      });
      const res = await runIssueIntakeReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        { agentInvoker, skipGithubEcho: true },
      );
      expect(res.draft?.kind).toBe("task");
      expect(res.draft?.title).toBe("Dark mode toggle");

      const comments = h.db
        .select()
        .from(schema.decisionComments)
        .where(eq(schema.decisionComments.decisionId, h.decisionId))
        .orderBy(asc(schema.decisionComments.createdAt))
        .all();
      expect(comments.length).toBe(1);
      expect(comments[0]?.role).toBe("agent");

      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, h.decisionId))
        .get();
      expect((decision?.payload as { draft?: { kind: string } }).draft?.kind).toBe("task");
    } finally {
      h.cleanup();
    }
  });
});
