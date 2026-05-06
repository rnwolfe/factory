import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import {
  appendOperatorComment,
  listFeedbackComments,
  runAgentReply,
} from "../src/feedback/iterate.ts";
import { PromoteError, promoteToPlan, promoteToTask } from "../src/feedback/promote.ts";
import { appendFeedback } from "../src/feedback/store.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  root: string;
  cleanup: () => void;
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
}

async function setup(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-feedback-iter-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
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
    gitAuthor: { name: "t", email: "t@t" },
    githubToken: null,
    factoryProjectId: null,
  };
  return {
    config,
    db,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function seedFactoryMetaProject(h: Harness) {
  const slug = "factory";
  const workdir = path.join(h.root, "projects", slug);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(path.join(workdir, ".factory", "work"), { recursive: true });
  writeFileSync(path.join(workdir, "README.md"), "# factory\n");
  await git(["init", "-q", "-b", "main"], workdir);
  await git(["config", "user.email", "t@t"], workdir);
  await git(["config", "user.name", "t"], workdir);
  await git(["add", "-A"], workdir);
  await git(["commit", "-q", "-m", "init"], workdir);
  const id = createId();
  const now = Date.now();
  h.db
    .insert(schema.projects)
    .values({
      id,
      slug,
      name: "factory",
      ideaId: null,
      role: "owner",
      ceremony: "personal",
      tag: "active",
      workdirPath: workdir,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
      githubRemote: null,
    })
    .run();
  return { id, workdir };
}

describe("feedback iterate", () => {
  test("appendOperatorComment + listFeedbackComments persist + return in chrono order", async () => {
    const h = await setup();
    try {
      const fb = appendFeedback(h.db, { vote: "up", body: "x" });
      if (!fb) throw new Error("seed failed");
      await appendOperatorComment(h.db, fb.id, "first");
      await appendOperatorComment(h.db, fb.id, "second");
      const list = await listFeedbackComments(h.db, fb.id);
      expect(list.length).toBe(2);
      expect(list[0]?.body).toBe("first");
      expect(list[1]?.body).toBe("second");
    } finally {
      h.cleanup();
    }
  });

  test("runAgentReply with stubbed invoker persists agent row + parses draft", async () => {
    const h = await setup();
    try {
      const fb = appendFeedback(h.db, { vote: "down", body: "scrollback in xterm is bad" });
      if (!fb) throw new Error("seed failed");
      await appendOperatorComment(h.db, fb.id, "any thoughts on improving xterm?");

      const result = await runAgentReply(h.db, fb.id, {
        agentInvoker: async () => ({
          text:
            "I'd recommend adding scrollback search. Here's a starting point.\n\n```json\n" +
            JSON.stringify({
              kind: "task",
              title: "xterm scrollback search",
              summary: "Add ctrl+f search inside the live pane terminal",
              reasoning: "Single discrete change, no decomposition needed.",
            }) +
            "\n```\n",
          sessionId: "stub-session",
          metrics: null,
        }),
      });

      expect(result.errorMessage).toBeNull();
      expect(result.draft).toBeTruthy();
      expect(result.draft?.kind).toBe("task");
      expect(result.draft?.title).toBe("xterm scrollback search");

      const persisted = await listFeedbackComments(h.db, fb.id);
      const agentRow = persisted.find((c) => c.role === "agent");
      expect(agentRow?.resultingDraft).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });
});

describe("feedback promote", () => {
  test("promoteToPlan refuses when factoryProjectId is unset", async () => {
    const h = await setup();
    try {
      const fb = appendFeedback(h.db, { vote: "up", body: "x" });
      if (!fb) throw new Error("seed failed");
      try {
        await promoteToPlan({ config: h.config, db: h.db, feedbackId: fb.id });
        throw new Error("expected PromoteError");
      } catch (err) {
        expect(err).toBeInstanceOf(PromoteError);
        expect((err as PromoteError).code).toBe("no_factory_project");
      }
    } finally {
      h.cleanup();
    }
  });

  test("promoteToPlan creates a feature_plan + marks feedback resolved", async () => {
    const h = await setup();
    try {
      const meta = await seedFactoryMetaProject(h);
      const config = { ...h.config, factoryProjectId: meta.id };
      const fb = appendFeedback(h.db, { vote: "down", body: "the dashboard inbox is too crowded" });
      if (!fb) throw new Error("seed failed");

      const result = await promoteToPlan({ config, db: h.db, feedbackId: fb.id });
      expect(result.planId).toBeTruthy();

      const plan = h.db.select().from(schema.plans).where(eq(schema.plans.id, result.planId)).get();
      expect(plan?.kind).toBe("feature_plan");
      expect(plan?.projectId).toBe(meta.id);
      expect(plan?.status).toBe("drafting");

      const fbAfter = h.db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, fb.id))
        .get();
      expect(fbAfter?.status).toBe("resolved");
      expect(fbAfter?.resolvedTarget).toBe(`plan:${result.planId}`);
    } finally {
      h.cleanup();
    }
  });

  test("promoteToTask creates a task file + marks feedback resolved", async () => {
    const h = await setup();
    try {
      const meta = await seedFactoryMetaProject(h);
      const config = { ...h.config, factoryProjectId: meta.id };
      const fb = appendFeedback(h.db, { vote: "down", body: "the inbox is crowded" });
      if (!fb) throw new Error("seed failed");

      const result = await promoteToTask({ config, db: h.db, feedbackId: fb.id });
      expect(result.projectId).toBe(meta.id);
      expect(result.taskId.startsWith("task-")).toBe(true);

      const fbAfter = h.db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, fb.id))
        .get();
      expect(fbAfter?.status).toBe("resolved");
      expect(fbAfter?.resolvedTarget).toBe(`task:${meta.id}:${result.taskId}`);
    } finally {
      h.cleanup();
    }
  });
});
