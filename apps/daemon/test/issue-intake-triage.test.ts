import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import {
  BOT_COMMENT_MARKER,
  factoryLinkFooter,
  loadProjectReplyContext,
  runIssueConversationReply,
  runIssueIntakeReply,
} from "../src/github/issue-triage.ts";
import {
  classifyWebhook,
  type GithubWebhookPayload,
  isAllowedReplyAuthor,
} from "../src/github/webhook.ts";

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
    expect(r.comment).toEqual({
      number: 7,
      commentId: 0,
      author: "alice",
      body: "any update?",
      authorAssociation: "NONE",
    });
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

  test("carries author_association from the comment payload", () => {
    const r = classifyWebhook(
      "issue_comment",
      commentPayload({
        comment: { body: "ping", user: { login: "alice" }, author_association: "COLLABORATOR" },
      }),
      PROJECTS,
    );
    expect(r.comment?.authorAssociation).toBe("COLLABORATOR");
  });

  test("carries the comment id (for the 👀 reaction)", () => {
    const r = classifyWebhook(
      "issue_comment",
      commentPayload({ comment: { id: 555, body: "ping", user: { login: "alice" } } }),
      PROJECTS,
    );
    expect(r.comment?.commentId).toBe(555);
  });
});

describe("isAllowedReplyAuthor — reply trust gate", () => {
  test("repo collaborators are always allowed, regardless of the allowlist", () => {
    for (const assoc of ["OWNER", "COLLABORATOR", "MEMBER"]) {
      expect(isAllowedReplyAuthor("bob", assoc, [])).toBe(true);
    }
  });

  test("non-collaborators are allowed only when explicitly listed (case-insensitive)", () => {
    expect(isAllowedReplyAuthor("Alice", "NONE", ["alice"])).toBe(true);
    expect(isAllowedReplyAuthor("alice", "CONTRIBUTOR", ["alice"])).toBe(true);
    expect(isAllowedReplyAuthor("mallory", "NONE", ["alice"])).toBe(false);
  });

  test("deny-by-default: empty allowlist + no write-access stays silent", () => {
    expect(isAllowedReplyAuthor("stranger", "NONE", [])).toBe(false);
    expect(isAllowedReplyAuthor("stranger", "CONTRIBUTOR", [])).toBe(false);
  });
});

describe("factoryLinkFooter — deep links back into Factory", () => {
  test("renders absolute links when a base URL is set", () => {
    const footer = factoryLinkFooter("https://heimdall.example.com", [
      { label: "task #7", path: "/projects/p1/tasks/7" },
      { label: "project", path: "/projects/p1" },
    ]);
    expect(footer).toContain("https://heimdall.example.com/projects/p1/tasks/7");
    expect(footer).toContain("[project](https://heimdall.example.com/projects/p1)");
    expect(footer).toContain("open in Factory");
  });

  test("omits the footer entirely when no base URL is configured", () => {
    expect(factoryLinkFooter(null, [{ label: "x", path: "/x" }])).toBe("");
    expect(factoryLinkFooter("https://x", [])).toBe("");
  });
});

describe("runIssueConversationReply — free-form issue reply", () => {
  test("builds a reply from the live thread and reports it", async () => {
    const h = setup();
    try {
      let seenPrompt = "";
      const agentInvoker = async (prompt: string) => {
        seenPrompt = prompt;
        return { text: "  Thanks — I'll look into the crash on startup.  ", sessionId: null };
      };
      const res = await runIssueConversationReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        42,
        {
          agentInvoker,
          skipGithubEcho: true,
          conversation: {
            title: "App crashes on launch",
            body: "Stack trace attached.",
            discussion: "[@alice · no-write]\nany update?",
          },
        },
      );
      expect(res.errorMessage).toBeNull();
      expect(res.body).toBe("Thanks — I'll look into the crash on startup.");
      // Prompt carries issue + thread context.
      expect(seenPrompt).toContain("App crashes on launch");
      expect(seenPrompt).toContain("any update?");
    } finally {
      h.cleanup();
    }
  });

  test("injects project context + reply guardrails into the prompt", async () => {
    const h = setup();
    try {
      let seenPrompt = "";
      const agentInvoker = async (prompt: string) => {
        seenPrompt = prompt;
        return { text: "ack", sessionId: null };
      };
      await runIssueConversationReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        7,
        {
          agentInvoker,
          skipGithubEcho: true,
          conversation: { title: "Q", body: "", discussion: "[@alice · write-access]\nhow?" },
          context: {
            projectName: "Heimdall",
            repo: "rnwolfe/heimdall",
            agentsMd: "Heimdall orchestrates coding agents.",
            readme: "(none)",
            vision: "Phone-first dispatcher console.",
          },
        },
      );
      expect(seenPrompt).toContain("Heimdall");
      expect(seenPrompt).toContain("orchestrates coding agents");
      expect(seenPrompt).toContain("Phone-first dispatcher console");
      // Guardrail: must not claim to have made code changes; UNTRUSTED framing.
      expect(seenPrompt).toContain("UNTRUSTED INPUT");
      // The reply agent is told to investigate the checked-out repo first, but
      // must not mutate it (read-only).
      expect(seenPrompt).toContain("INVESTIGATE it");
      expect(seenPrompt.toLowerCase()).toContain("you must not change it");
    } finally {
      h.cleanup();
    }
  });

  test("loadProjectReplyContext reads AGENTS.md + derives repo/name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-ctx-"));
    try {
      const wd = path.join(root, "proj");
      mkdirSync(wd, { recursive: true });
      writeFileSync(path.join(wd, "AGENTS.md"), "Operating manual: be careful.");
      const ctx = await loadProjectReplyContext({
        id: "p",
        name: "Proj",
        workdirPath: wd,
        githubRemote: "https://github.com/acme/proj.git",
        taskBackend: "github-issues",
      });
      expect(ctx.projectName).toBe("Proj");
      expect(ctx.repo).toBe("acme/proj");
      expect(ctx.agentsMd).toContain("Operating manual");
      expect(ctx.readme).toBe("(none)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no-ops cleanly when the issue can't be fetched", async () => {
    const h = setup();
    try {
      const res = await runIssueConversationReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        99,
        { conversation: null },
      );
      expect(res.posted).toBe(false);
      expect(res.errorMessage).toContain("not found");
    } finally {
      h.cleanup();
    }
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

  test("prompt tells the agent to investigate the checked-out repo first", async () => {
    const h = setup();
    try {
      let seenPrompt = "";
      const agentInvoker = async (prompt: string) => {
        seenPrompt = prompt;
        return { text: 'ack\n\n```json\n{"kind":"dismiss"}\n```', sessionId: null, metrics: null };
      };
      await runIssueIntakeReply(
        { db: h.db, events: h.events, config: h.config, project: h.project },
        h.decisionId,
        { agentInvoker, skipGithubEcho: true },
      );
      expect(seenPrompt).toContain("Investigate first");
      expect(seenPrompt.toLowerCase()).toContain("repository is checked out");
    } finally {
      h.cleanup();
    }
  });
});
