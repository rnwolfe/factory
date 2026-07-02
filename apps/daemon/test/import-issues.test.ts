import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { raiseIssueImportDecision } from "../src/projects/import-issues.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type FakeFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const asFetch = (f: FakeFetch) => f as unknown as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

/** A fetch that returns the given open issues from the list endpoint. */
function issuesFetch(issues: unknown[]): typeof fetch {
  return asFetch(async (url) => {
    const u = String(url);
    if (u.includes("/access_tokens")) {
      return json({ token: "ghs_test", expires_at: new Date(99_999_999_999).toISOString() });
    }
    if (u.includes("/installation")) return json({ id: 42 });
    if (u.includes("/issues?")) return json(issues);
    throw new Error(`unexpected ${u}`);
  });
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-import-issues-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  const events = new EventBus();
  const config = {
    githubApp: { appId: "1", slug: "wolfefactory", privateKey, webhookSecret: null },
  } as unknown as FactoryConfig;
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id: "p1",
      slug: "p1",
      name: "P1",
      ceremony: "tinker",
      workdirPath: path.join(root, "p1"),
      taskBackend: "github-issues",
      githubRemote: "https://github.com/o/r.git",
      githubInstallationId: 42,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return { db, events, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const openIssue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "external",
  state: "open",
  state_reason: null,
  labels: [],
  user: { login: "octocat" },
  html_url: `https://github.com/o/r/issues/${number}`,
  ...extra,
});

describe("raiseIssueImportDecision", () => {
  test("raises ONE issue_import decision listing untracked upstream issues", async () => {
    const h = setup();
    try {
      const res = await raiseIssueImportDecision(
        { db: h.db, events: h.events, config: h.config },
        "p1",
        issuesFetch([openIssue(4), openIssue(5)]),
      );
      expect(res.candidates).toBe(2);
      expect(res.decisionId).not.toBeNull();

      const rows = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.kind, "issue_import"))
        .all();
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("pending");
      const payload = rows[0]?.payload as { candidates: Array<{ number: number }> };
      expect(payload.candidates.map((c) => c.number)).toEqual([4, 5]);
    } finally {
      h.cleanup();
    }
  });

  test("is idempotent: re-running refreshes the pending decision, no duplicate", async () => {
    const h = setup();
    try {
      const first = await raiseIssueImportDecision(
        { db: h.db, events: h.events, config: h.config },
        "p1",
        issuesFetch([openIssue(4)]),
      );
      const second = await raiseIssueImportDecision(
        { db: h.db, events: h.events, config: h.config },
        "p1",
        issuesFetch([openIssue(4), openIssue(9)]),
      );
      expect(second.decisionId).toBe(first.decisionId);
      const rows = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.kind, "issue_import"))
        .all();
      expect(rows.length).toBe(1);
      const payload = rows[0]?.payload as { candidates: Array<{ number: number }> };
      expect(payload.candidates.map((c) => c.number)).toEqual([4, 9]);
    } finally {
      h.cleanup();
    }
  });

  test("nothing to import → no decision, and any stale pending one is cleared", async () => {
    const h = setup();
    try {
      const first = await raiseIssueImportDecision(
        { db: h.db, events: h.events, config: h.config },
        "p1",
        issuesFetch([openIssue(4)]),
      );
      // Second run finds the issue already adopted (factory-labeled) → 0 candidates.
      const second = await raiseIssueImportDecision(
        { db: h.db, events: h.events, config: h.config },
        "p1",
        issuesFetch([]),
      );
      expect(second.candidates).toBe(0);
      expect(second.decisionId).toBeNull();
      const stale = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, first.decisionId ?? ""))
        .get();
      expect(stale?.status).toBe("dismissed");
    } finally {
      h.cleanup();
    }
  });

  test("refuses on a file-backed project", async () => {
    const h = setup();
    try {
      h.db
        .update(schema.projects)
        .set({ taskBackend: "file" })
        .where(eq(schema.projects.id, "p1"))
        .run();
      await expect(
        raiseIssueImportDecision(
          { db: h.db, events: h.events, config: h.config },
          "p1",
          issuesFetch([]),
        ),
      ).rejects.toThrow(/GitHub Issues backend/);
    } finally {
      h.cleanup();
    }
  });
});
