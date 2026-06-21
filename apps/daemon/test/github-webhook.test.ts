import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { EventBus } from "../src/events.ts";
import {
  classifyWebhook,
  type GithubWebhookPayload,
  handleGithubWebhook,
  verifyGithubSignature,
} from "../src/github/webhook.ts";

const SECRET = "s3cr3t";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifyGithubSignature", () => {
  test("accepts a correct signature", () => {
    const body = '{"hello":"world"}';
    expect(verifyGithubSignature(SECRET, body, sign(body))).toBe(true);
  });
  test("rejects a wrong signature, missing header, and wrong secret", () => {
    const body = '{"hello":"world"}';
    expect(verifyGithubSignature(SECRET, body, "sha256=deadbeef")).toBe(false);
    expect(verifyGithubSignature(SECRET, body, null)).toBe(false);
    expect(verifyGithubSignature("other", body, sign(body))).toBe(false);
  });
});

const PROJECTS = [
  {
    id: "p-int",
    githubRemote: "https://github.com/rnwolfe/integrated.git",
    taskBackend: "github-issues",
  },
  { id: "p-file", githubRemote: "https://github.com/rnwolfe/filebacked.git", taskBackend: "file" },
];

function issuePayload(
  repo: string,
  over: Partial<GithubWebhookPayload> = {},
): GithubWebhookPayload {
  return {
    action: "opened",
    repository: { full_name: repo },
    issue: { number: 1, title: "t", labels: [] },
    ...over,
  };
}

function setupDb() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-webhook-test-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

async function insertGithubIssueProject(db: ReturnType<typeof createDb>): Promise<string> {
  const id = "p-intake";
  const now = Date.now();
  await db.insert(schema.projects).values({
    id,
    slug: "intake",
    name: "intake",
    ceremony: "tinker",
    workdirPath: "/tmp/intake",
    createdAt: now,
    lastActivityAt: now,
    githubRemote: "https://github.com/rnwolfe/integrated.git",
    taskBackend: "github-issues",
  });
  return id;
}

describe("classifyWebhook gating", () => {
  test("ignores repos with no github-issues-backed project", () => {
    expect(classifyWebhook("issues", issuePayload("rnwolfe/unknown"), PROJECTS).status).toBe(
      "ignored",
    );
    expect(classifyWebhook("issues", issuePayload("rnwolfe/filebacked"), PROJECTS).status).toBe(
      "ignored",
    );
  });

  test("ignores installation and non-issue events", () => {
    expect(classifyWebhook("installation", {}, PROJECTS).status).toBe("ignored");
    expect(classifyWebhook("push", issuePayload("rnwolfe/integrated"), PROJECTS).status).toBe(
      "ignored",
    );
  });

  test("ignores pull requests on the issues stream", () => {
    const pr = issuePayload("rnwolfe/integrated", {
      issue: { number: 2, pull_request: { url: "x" } },
    });
    expect(classifyWebhook("issues", pr, PROJECTS).status).toBe("ignored");
  });

  test("processes an integrated repo's comment event", () => {
    const r = classifyWebhook(
      "issue_comment",
      issuePayload("rnwolfe/integrated", { action: "created" }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.projectId).toBe("p-int");
  });

  test("flags an externally-opened issue for intake", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", {
        issue: { number: 9, title: "Bug", user: { login: "alice" } },
      }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.intake).toEqual({ number: 9, title: "Bug", author: "alice" });
  });

  test("carries issue html_url when flagging an externally-opened issue for intake", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", {
        issue: {
          number: 9,
          title: "Bug",
          html_url: "https://github.com/rnwolfe/integrated/issues/9",
          user: { login: "alice" },
        },
      }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.intake).toEqual({
      number: 9,
      title: "Bug",
      author: "alice",
      htmlUrl: "https://github.com/rnwolfe/integrated/issues/9",
    });
  });

  test("does not flag a factory-authored opened issue for intake", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", { issue: { number: 3, labels: [{ name: "factory" }] } }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.reason).toContain("factory-authored");
  });

  test("flags a closed issue for a live task-list refresh", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", { action: "closed", issue: { number: 12 } }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.projectId).toBe("p-int");
    expect(r.taskUpdate).toEqual({ number: 12, action: "closed" });
  });

  test("flags a reopened issue for a live task-list refresh", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", { action: "reopened", issue: { number: 12 } }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.taskUpdate).toEqual({ number: 12, action: "reopened" });
  });
});

describe("handleGithubWebhook issue_intake payload", () => {
  test("creates an issue_intake decision payload with html_url when GitHub provides one", async () => {
    const { db, cleanup } = setupDb();
    try {
      const projectId = await insertGithubIssueProject(db);
      const published: unknown[] = [];
      const events = new EventBus();
      events.subscribe((event) => published.push(event));
      const result = await handleGithubWebhook(
        { db, events },
        "issues",
        issuePayload("rnwolfe/integrated", {
          issue: {
            number: 44,
            title: "Expose provenance links",
            html_url: "https://github.com/rnwolfe/integrated/issues/44",
            user: { login: "octocat" },
          },
        }),
      );

      const rows = await db.select().from(schema.decisions).all();
      expect(result.status).toBe("processed");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("issue_intake");
      expect(rows[0]?.projectId).toBe(projectId);
      expect(rows[0]?.payload).toEqual({
        number: 44,
        title: "Expose provenance links",
        author: "octocat",
        htmlUrl: "https://github.com/rnwolfe/integrated/issues/44",
      });
      expect(published).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("publishes a task_updated event when a tracked issue is closed on GitHub", async () => {
    const { db, cleanup } = setupDb();
    try {
      const projectId = await insertGithubIssueProject(db);
      const published: unknown[] = [];
      const events = new EventBus();
      events.subscribe((event) => published.push(event));
      const result = await handleGithubWebhook(
        { db, events },
        "issues",
        issuePayload("rnwolfe/integrated", { action: "closed", issue: { number: 24 } }),
      );

      expect(result.status).toBe("processed");
      expect(result.taskUpdate).toEqual({ number: 24, action: "closed" });
      // No decision row — a state change is not an inbox item.
      expect(await db.select().from(schema.decisions).all()).toHaveLength(0);
      expect(published).toEqual([
        {
          channel: "events",
          kind: "task_updated",
          projectId,
          taskId: "24",
          action: "closed",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("creates an issue_intake decision payload without a URL for older payload shapes", async () => {
    const { db, cleanup } = setupDb();
    try {
      await insertGithubIssueProject(db);
      await handleGithubWebhook(
        { db, events: new EventBus() },
        "issues",
        issuePayload("rnwolfe/integrated", {
          issue: {
            number: 45,
            title: "Legacy issue event",
            user: { login: "octocat" },
          },
        }),
      );

      const rows = await db.select().from(schema.decisions).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({
        number: 45,
        title: "Legacy issue event",
        author: "octocat",
      });
    } finally {
      cleanup();
    }
  });
});
