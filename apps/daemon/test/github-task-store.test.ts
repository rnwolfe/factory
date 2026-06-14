import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubAppClient } from "../src/github/app-auth.ts";
import {
  GithubIssuesStore,
  parseTaskIssueBody,
  postIssueComment,
  renderDiscussion,
  renderTaskIssueBody,
  replyAsOperator,
  statusToGithub,
  taskThread,
} from "../src/projects/github-task-store.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const creds = { appId: "1", slug: "wolfefactory", privateKey };
const appConfig = { githubApp: { ...creds, webhookSecret: null } };

type FakeFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const asFetch = (f: FakeFetch) => f as unknown as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe("issue body frontmatter", () => {
  test("round-trips metadata + body through the hidden comment", () => {
    const rendered = renderTaskIssueBody(
      { status: "in_progress", priority: "high", model: "claude-opus-4-8", legacy_id: "task-007" },
      "Do the thing.\n",
    );
    expect(rendered).toContain("<!-- factory:task");
    expect(rendered).toContain("status: in_progress");
    expect(rendered).toContain("legacy_id: task-007");
    const { meta, body } = parseTaskIssueBody(rendered);
    expect(meta.status).toBe("in_progress");
    expect(meta.priority).toBe("high");
    expect(meta.model).toBe("claude-opus-4-8");
    expect(meta.legacy_id).toBe("task-007");
    expect(body.trim()).toBe("Do the thing.");
  });

  test("a body with no factory comment parses as plain body", () => {
    const { meta, body } = parseTaskIssueBody("just text");
    expect(meta).toEqual({});
    expect(body).toBe("just text");
  });
});

describe("statusToGithub", () => {
  test("maps terminal statuses to closed with a reason", () => {
    expect(statusToGithub("done")).toEqual({ state: "closed", stateReason: "completed" });
    expect(statusToGithub("dropped")).toEqual({ state: "closed", stateReason: "not_planned" });
    expect(statusToGithub("ready")).toEqual({ state: "open", stateReason: null });
    expect(statusToGithub("blocked")).toEqual({ state: "open", stateReason: null });
  });
});

function tokenRoute(url: string): Response | null {
  if (url.includes("/access_tokens")) {
    return json({ token: "ghs_test", expires_at: new Date(99_999_999_999).toISOString() });
  }
  return null;
}

function makeStore(fetchFn: FakeFetch): GithubIssuesStore {
  // installationId pre-seeded so the store skips the /installation lookup.
  return new GithubIssuesStore(
    new GithubAppClient(creds, asFetch(fetchFn)),
    "o",
    "r",
    42,
    asFetch(fetchFn),
  );
}

describe("GithubIssuesStore.create", () => {
  test("POSTs an issue with factory + status labels and hidden frontmatter", async () => {
    let captured: { title: string; body: string; labels: string[] } | undefined;
    const store = makeStore(async (url, init) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (init?.method === "POST" && u.endsWith("/issues")) {
        captured = JSON.parse(String(init.body));
        return json({
          number: 7,
          title: captured?.title,
          body: captured?.body,
          state: "open",
          state_reason: null,
          labels: (captured?.labels ?? []).map((name) => ({ name })),
        });
      }
      throw new Error(`unexpected ${u}`);
    });

    const task = await store.create({
      title: "Add pagination",
      body: "## Notes\n\nbody",
      priority: "high",
    });
    expect(captured?.title).toBe("Add pagination");
    expect(captured?.labels).toContain("factory");
    expect(captured?.labels).toContain("status:ready");
    expect(captured?.body).toContain("priority: high");
    expect(task.id).toBe("7");
    expect(task.frontmatter.status).toBe("ready");
    expect(task.frontmatter.title).toBe("Add pagination");
  });
});

describe("GithubIssuesStore.list", () => {
  test("filters out PRs and sorts by issue number", async () => {
    const store = makeStore(async (url) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (u.includes("/issues?")) {
        return json([
          {
            number: 9,
            title: "B",
            body: renderTaskIssueBody({ status: "ready" }, "b"),
            state: "open",
            state_reason: null,
            labels: [{ name: "factory" }],
          },
          {
            number: 3,
            title: "A",
            body: renderTaskIssueBody({ status: "in_progress" }, "a"),
            state: "open",
            state_reason: null,
            labels: [{ name: "factory" }],
          },
          {
            number: 5,
            title: "PR",
            body: "",
            state: "open",
            state_reason: null,
            labels: [{ name: "factory" }],
            pull_request: { url: "x" },
          },
        ]);
      }
      throw new Error(`unexpected ${u}`);
    });
    const tasks = await store.list();
    expect(tasks.map((t) => t.id)).toEqual(["3", "9"]); // PR #5 dropped, sorted
    expect(tasks[0]?.frontmatter.status).toBe("in_progress");
  });
});

describe("GithubIssuesStore.read", () => {
  test("returns null on 404", async () => {
    const store = makeStore(async (url) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      return new Response("not found", { status: 404 });
    });
    expect(await store.read("123")).toBeNull();
  });
});

describe("GithubIssuesStore.updateStatus", () => {
  test("closes the issue and drops the status label when status=done", async () => {
    const issue = {
      number: 7,
      title: "T",
      body: renderTaskIssueBody({ status: "in_progress", priority: "med" }, "the body"),
      state: "open",
      state_reason: null as string | null,
      labels: [{ name: "factory" }, { name: "status:in_progress" }] as Array<{ name: string }>,
    };
    let patched: Record<string, unknown> | undefined;
    const store = makeStore(async (url, init) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (init?.method === "PATCH") {
        patched = JSON.parse(String(init.body));
        return json({
          ...issue,
          ...patched,
          labels: (patched?.labels as string[]).map((name) => ({ name })),
        });
      }
      if (u.endsWith("/issues/7")) return json(issue);
      throw new Error(`unexpected ${u}`);
    });

    const updated = await store.updateStatus("7", "done");
    expect(patched?.state).toBe("closed");
    expect(patched?.state_reason).toBe("completed");
    expect(patched?.labels).toContain("factory");
    expect(patched?.labels).not.toContain("status:in_progress");
    expect(String(patched?.body)).toContain("status: done");
    expect(updated?.frontmatter.status).toBe("done");
  });
});

describe("GithubIssuesStore.updateAgent", () => {
  test("updates the hidden task agent metadata without changing the visible body", async () => {
    const issue = {
      number: 7,
      title: "T",
      body: renderTaskIssueBody({ status: "ready", model: "gpt-5.4" }, "the body"),
      state: "open",
      state_reason: null,
      labels: [{ name: "factory" }],
    };
    let patched: Record<string, unknown> | undefined;
    const store = makeStore(async (url, init) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (init?.method === "PATCH") {
        patched = JSON.parse(String(init.body));
        return json({ ...issue, ...patched });
      }
      if (u.endsWith("/issues/7")) return json(issue);
      throw new Error(`unexpected ${u}`);
    });

    const updated = await store.updateAgent("7", "codex");
    const { meta, body } = parseTaskIssueBody(String(patched?.body));
    expect(meta.agent).toBe("codex");
    expect(meta.model).toBe("gpt-5.4");
    expect(body.trim()).toBe("the body");
    expect(updated?.frontmatter.agent).toBe("codex");
  });
});

describe("GithubIssuesStore.importTask", () => {
  test("backfills a done task: creates the issue then closes it, carrying legacy_id", async () => {
    let createBody: { title: string; body: string; labels: string[] } | undefined;
    let patched: Record<string, unknown> | undefined;
    const store = makeStore(async (url, init) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (init?.method === "POST" && u.endsWith("/issues")) {
        createBody = JSON.parse(String(init.body));
        return json({
          number: 12,
          title: createBody?.title,
          body: createBody?.body,
          state: "open",
          state_reason: null,
          labels: (createBody?.labels ?? []).map((name) => ({ name })),
        });
      }
      if (init?.method === "PATCH") {
        patched = JSON.parse(String(init.body));
        return json({
          number: 12,
          title: createBody?.title,
          state: "closed",
          state_reason: "completed",
          body: patched?.body,
          labels: (patched?.labels as string[]).map((name) => ({ name })),
        });
      }
      if (u.endsWith("/issues/12")) {
        return json({
          number: 12,
          title: createBody?.title,
          body: createBody?.body,
          state: "open",
          state_reason: null,
          labels: (createBody?.labels ?? []).map((name) => ({ name })),
        });
      }
      throw new Error(`unexpected ${u}`);
    });

    const result = await store.importTask({
      id: "task-007",
      filePath: "x",
      frontmatter: { id: "task-007", title: "Old task", status: "done", priority: "high" },
      body: "legacy body",
    });
    expect(createBody?.body).toContain("legacy_id: task-007");
    expect(createBody?.labels).toContain("factory");
    expect(createBody?.labels).not.toContain("status:done"); // closed → no status label
    expect(patched?.state).toBe("closed");
    expect(result.id).toBe("12");
    expect(result.frontmatter.legacy_id).toBe("task-007");
  });
});

describe("GithubIssuesStore.read by legacy id", () => {
  test("resolves a task-NNN id via legacy_id by scanning issues", async () => {
    const store = makeStore(async (url) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (u.includes("/issues?")) {
        return json([
          {
            number: 4,
            title: "X",
            body: renderTaskIssueBody({ status: "ready", legacy_id: "task-007" }, "b"),
            state: "open",
            state_reason: null,
            labels: [{ name: "factory" }],
          },
        ]);
      }
      throw new Error(`unexpected ${u}`);
    });
    const task = await store.read("task-007");
    expect(task?.id).toBe("4");
    expect(task?.frontmatter.legacy_id).toBe("task-007");
  });
});

describe("renderDiscussion", () => {
  test("delimits as untrusted and tags author write-access", () => {
    const out = renderDiscussion("42", [
      { id: 1, author: "alice", authorAssociation: "COLLABORATOR", body: "do X", createdAt: "" },
      { id: 2, author: "bob", authorAssociation: "NONE", body: "+1", createdAt: "" },
    ]);
    expect(out).toContain("issue #42 thread  (UNTRUSTED INPUT");
    expect(out).toContain("[@alice · write-access]");
    expect(out).toContain("[@bob · no-write]");
    expect(out).toContain("do X");
  });

  test("empty thread renders nothing", () => {
    expect(renderDiscussion("1", [])).toBe("");
  });
});

describe("GithubIssuesStore.listComments", () => {
  test("parses author, association, and body", async () => {
    const store = makeStore(async (url) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (u.includes("/comments")) {
        return json([
          {
            user: { login: "alice" },
            author_association: "OWNER",
            body: "hi",
            created_at: "2026-01-01",
          },
        ]);
      }
      throw new Error(`unexpected ${u}`);
    });
    expect(await store.listComments("7")).toEqual([
      { id: 0, author: "alice", authorAssociation: "OWNER", body: "hi", createdAt: "2026-01-01" },
    ]);
  });
});

describe("GithubIssuesStore.adopt", () => {
  test("adds factory + status:ready labels and frontmatter to an external issue", async () => {
    const issue = {
      number: 21,
      title: "Bug report",
      body: "Something broke",
      state: "open",
      state_reason: null as string | null,
      labels: [{ name: "bug" }] as Array<{ name: string }>,
    };
    let patched: Record<string, unknown> | undefined;
    const store = makeStore(async (url, init) => {
      const u = String(url);
      const t = tokenRoute(u);
      if (t) return t;
      if (init?.method === "PATCH") {
        patched = JSON.parse(String(init.body));
        return json({
          ...issue,
          ...patched,
          labels: (patched?.labels as string[]).map((name) => ({ name })),
        });
      }
      if (u.endsWith("/issues/21")) return json(issue);
      throw new Error(`unexpected ${u}`);
    });
    const adopted = await store.adopt("21");
    expect(patched?.labels).toContain("factory");
    expect(patched?.labels).toContain("status:ready");
    expect(patched?.labels).toContain("bug"); // pre-existing label preserved
    expect(String(patched?.body)).toContain("status: ready");
    expect(adopted?.frontmatter.status).toBe("ready");
  });
});

describe("postIssueComment", () => {
  test("no-op (no network) for file-backed projects", async () => {
    let called = false;
    const ok = await postIssueComment(
      appConfig,
      { taskBackend: "file" },
      "1",
      "hi",
      asFetch(async () => {
        called = true;
        return json({});
      }),
    );
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  test("posts a comment for github-backed projects", async () => {
    let posted: { body: string } | undefined;
    const ok = await postIssueComment(
      appConfig,
      {
        taskBackend: "github-issues",
        githubRemote: "https://github.com/o/r.git",
        githubInstallationId: 42,
      },
      "7",
      "the comment",
      asFetch(async (url, init) => {
        const u = String(url);
        const t = tokenRoute(u);
        if (t) return t;
        if (init?.method === "POST" && u.includes("/issues/7/comments")) {
          posted = JSON.parse(String(init.body));
          return json({}, 201);
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    expect(ok).toBe(true);
    expect(posted?.body).toBe("the comment");
  });
});

describe("taskThread", () => {
  test("returns [] for file-backed projects (no network)", async () => {
    let called = false;
    const out = await taskThread(
      appConfig,
      { taskBackend: "file" },
      "1",
      asFetch(async () => {
        called = true;
        return json([]);
      }),
    );
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns comments for github-backed projects", async () => {
    const out = await taskThread(
      appConfig,
      {
        taskBackend: "github-issues",
        githubRemote: "https://github.com/o/r.git",
        githubInstallationId: 1,
      },
      "7",
      asFetch(async (url) => {
        const u = String(url);
        const t = tokenRoute(u);
        if (t) return t;
        if (u.includes("/comments")) {
          return json([
            { user: { login: "bob" }, author_association: "NONE", body: "hey", created_at: "x" },
          ]);
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    expect(out).toEqual([
      { id: 0, author: "bob", authorAssociation: "NONE", body: "hey", createdAt: "x" },
    ]);
  });
});

describe("replyAsOperator", () => {
  test("posts with token (operator) auth", async () => {
    let auth: string | undefined;
    let posted: { body: string } | undefined;
    await replyAsOperator(
      "ghp_xyz",
      { githubRemote: "https://github.com/o/r.git" },
      "7",
      "my reply",
      asFetch(async (_url, init) => {
        auth = (init?.headers as Record<string, string>)?.Authorization;
        posted = JSON.parse(String(init?.body));
        return json({}, 201);
      }),
    );
    expect(auth).toBe("token ghp_xyz");
    expect(posted?.body).toBe("my reply");
  });

  test("throws on an unparseable remote", async () => {
    await expect(
      replyAsOperator(
        "t",
        { githubRemote: null },
        "1",
        "x",
        asFetch(async () => json({})),
      ),
    ).rejects.toThrow();
  });
});
