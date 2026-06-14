import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, openSqlite, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { EventBus } from "../src/events.ts";
import { decisionsRouter } from "../src/routers/decisions.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

const createCaller = createCallerFactory(decisionsRouter);

function ensureSnoozeColumn(dbPath: string): void {
  // Test migrations currently lag the schema for snoozed inbox rows.
  // The decisions router already queries this column, so this harness keeps
  // the focused router test aligned with the current schema.
  const sqlite = openSqlite(dbPath);
  try {
    sqlite.exec("ALTER TABLE decisions ADD COLUMN snoozed_until integer");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("duplicate column name")) {
      throw err;
    }
  } finally {
    sqlite.close();
  }
}

function setupHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-decisions-router-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  ensureSnoozeColumn(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  const ctx: DaemonContext = {
    db,
    events,
    runs: new RunRegistry(),
    pool: new WorkerPool(1),
    config,
    scripts: new ScriptRegistry(events),
    authorized: true,
  };
  return {
    db,
    caller: createCaller(ctx),
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("decisionsRouter", () => {
  test("inbox and get include projectName for project-linked decisions", async () => {
    const h = setupHarness();
    try {
      const now = Date.now();
      const projectId = createId();
      const projectPath = path.join(h.root, "projects", "alpha");
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "alpha",
        name: "Alpha Console",
        ceremony: "personal",
        workdirPath: projectPath,
        createdAt: now,
        lastActivityAt: now,
      });

      const projectDecisionId = createId();
      const triageDecisionId = createId();
      await h.db.insert(schema.decisions).values([
        {
          id: projectDecisionId,
          kind: "blocked_run",
          projectId,
          outcome: "blocked",
          payload: { summary: "needs operator input" },
          status: "pending",
          createdAt: now + 1,
        },
        {
          id: triageDecisionId,
          kind: "triage",
          projectId: null,
          outcome: "greenlit",
          payload: { title_suggestion: "New thing" },
          status: "pending",
          createdAt: now,
        },
      ]);

      const inbox = await h.caller.inbox();
      expect(inbox.find((row) => row.id === projectDecisionId)?.projectName).toBe("Alpha Console");
      expect(inbox.find((row) => row.id === triageDecisionId)?.projectName).toBeNull();

      const fetched = await h.caller.get({ id: projectDecisionId });
      expect(fetched?.projectName).toBe("Alpha Console");
    } finally {
      h.cleanup();
    }
  });
});
