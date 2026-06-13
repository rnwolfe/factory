import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  classifyWebhook,
  type GithubWebhookPayload,
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

  test("does not flag a factory-authored opened issue for intake", () => {
    const r = classifyWebhook(
      "issues",
      issuePayload("rnwolfe/integrated", { issue: { number: 3, labels: [{ name: "factory" }] } }),
      PROJECTS,
    );
    expect(r.status).toBe("processed");
    expect(r.reason).toContain("factory-authored");
  });
});
