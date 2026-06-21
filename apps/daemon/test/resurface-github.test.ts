import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { resurfaceWorkForDecision } from "../src/decisions/resurface.ts";
import { GithubAppClient } from "../src/github/app-auth.ts";
import { parseTaskIssueBody } from "../src/projects/github-task-store.ts";
import { configureGithubTaskBackend } from "../src/projects/tasks.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const creds = { appId: "1", slug: "wolfefactory", privateKey };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

const githubTarget = {
  workdirPath: "/tmp/unused",
  taskBackend: "github-issues" as const,
  githubRemote: "https://github.com/o/r.git",
  githubInstallationId: 42,
};

afterEach(() => {
  configureGithubTaskBackend(null);
});

describe("resurfaceWorkForDecision — github-issues backend (task-063)", () => {
  test("opens a follow-up issue linking back to the original closed issue, never reopening it", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let created: { title: string; body: string; labels: string[] } | undefined;

    // The public seam (`taskStoreFor` → GithubIssuesStore) uses globalThis.fetch
    // for the issue API, so stub it for the duration of this test. The token
    // route is the only other call the store makes.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url: u, body });
      if (u.includes("/access_tokens")) {
        return json({ token: "ghs_test", expires_at: new Date(99_999_999_999_000).toISOString() });
      }
      if (method === "POST" && u.endsWith("/issues")) {
        created = body as { title: string; body: string; labels: string[] };
        return json({
          number: 108,
          title: created.title,
          body: created.body,
          state: "open",
          state_reason: null,
          labels: (created.labels ?? []).map((name) => ({ name })),
        });
      }
      throw new Error(`unexpected ${method} ${u}`);
    }) as typeof fetch;

    configureGithubTaskBackend(new GithubAppClient(creds));

    try {
      const task = await resurfaceWorkForDecision(githubTarget, {
        decisionId: "dec-xyz",
        summary: "Which SQLite driver?",
        agentDecided: "bun:sqlite",
        answer: "better-sqlite3",
        originalTaskId: "42",
        runId: "run-123",
        options: [{ title: "bun:sqlite" }, { title: "better-sqlite3" }],
      });

      // The follow-up issue IS the new task (its number is the task id).
      expect(task.id).toBe("108");
      expect(task.frontmatter.status).toBe("ready");

      // It links back to the original issue with a GitHub-native `#N` reference
      // (which GitHub records as a cross-reference on the original), and the
      // visible body states the original stays closed.
      expect(created?.body).toContain("#42");
      expect(created?.body).toContain("stays closed");
      // ...not as a dead code-quoted number.
      expect(created?.body).not.toContain("`42`");

      // The operator's chosen answer is carried into the body so the implementer
      // sees what to build.
      expect(created?.body).toContain("better-sqlite3");

      // Machine-readable provenance: the audit link to the decision and the
      // parent pointer to the original issue both ride in the hidden frontmatter.
      const { meta } = parseTaskIssueBody(created?.body ?? "");
      expect(meta.sourceDecisionId).toBe("dec-xyz");
      expect(meta.parent).toBe("42");
      expect(created?.labels).toContain("resurfaced");

      // The original issue (#42) is never touched — no PATCH, no reopen. The
      // only mutating call is the POST that opens the follow-up.
      const mutating = calls.filter((c) => c.method !== "GET");
      expect(mutating.every((c) => c.method === "POST")).toBe(true);
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      expect(calls.some((c) => c.url.endsWith("/issues/42"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
