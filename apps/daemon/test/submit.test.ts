import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";

import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";
import { submitRun } from "../src/workers/submit.ts";

/**
 * Focused unit tests for `submitRun` — the two decisions with the most
 * operator-visible failure modes: the codex precheck (auth + resume-parity
 * refusals) and the agent/model resolution ladder. Execution is stubbed at
 * the worker-pool seam (`pool.submit` → no-op) so no worktree, tmux, or
 * agent process is ever spawned; we assert on the throw or on the persisted
 * run row.
 */

// Defensive: submitRun never touches tmux (pool.submit is stubbed), but pin a
// throwaway socket per CLAUDE.md regardless.
process.env.FACTORY_TMUX_SOCKET = `factory-test-submit-${process.pid}`;

async function git(args: string[], cwd: string): Promise<void> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  }
}

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-submit-unit-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const runs = new RunRegistry();
  const pool = new WorkerPool(1);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    runIdleTimeoutSeconds: 1200,
    agentBudgetSeconds: 0,
    eventRetentionDays: 30,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    githubReplyAllowlist: [],
    publicBaseUrl: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    events,
    runs,
    pool,
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

interface ProjectOpts {
  agent?: string | null;
  model?: string | null;
  taskFrontmatter?: { status?: string; agent?: string; model?: string };
  taskId?: string;
}

async function seedProject(h: Harness, opts: ProjectOpts = {}): Promise<string> {
  const slug = "submit-unit";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });

  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);

  if (opts.taskId) {
    await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
    const fm = opts.taskFrontmatter ?? {};
    const lines = [
      `---`,
      `id: ${opts.taskId}`,
      `title: ${opts.taskId}`,
      `status: ${fm.status ?? "ready"}`,
    ];
    if (fm.agent) lines.push(`agent: ${fm.agent}`);
    if (fm.model) lines.push(`model: ${fm.model}`);
    lines.push(`---`, ``, `body`, ``);
    await writeFile(
      path.join(workdirPath, ".factory", "work", `${opts.taskId}-demo.md`),
      lines.join("\n"),
      "utf8",
    );
  }

  await writeFile(path.join(workdirPath, "README.md"), "# init\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "init"], workdirPath);

  const now = Date.now();
  h.db
    .insert(schema.projects)
    .values({
      id: projectId,
      slug,
      name: slug,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: false,
      agent: opts.agent ?? null,
      model: opts.model ?? null,
      archivedAt: null,
    })
    .run();

  return projectId;
}

function deps(h: Harness) {
  return { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool };
}

describe("submitRun", () => {
  let prevCodexHome: string | undefined;
  let codexHome: string;

  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(path.join(tmpdir(), "factory-submit-codex-"));
    // Default: NO auth.json in the codex home (unauthenticated).
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  function writeCodexAuth() {
    writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-fake"}');
  }

  describe("codex precheck", () => {
    test("refuses a codex run when ~/.codex/auth.json is missing", async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        const projectId = await seedProject(h);
        await expect(submitRun(deps(h), { projectId, agent: "codex" })).rejects.toThrow(
          /not authenticated/i,
        );
        // No run row was inserted, and execution never scheduled.
        expect(h.db.select().from(schema.runs).all().length).toBe(0);
        expect(submitSpy).not.toHaveBeenCalled();
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });

    test("refuses a codex run that needs session resume (resume unsupported)", async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        // Auth present, so the refusal is unambiguously the resume-parity gate
        // (which is checked before the auth probe).
        writeCodexAuth();
        const projectId = await seedProject(h);
        await expect(
          submitRun(deps(h), { projectId, agent: "codex", resumeFromSessionId: "sess-1" }),
        ).rejects.toThrow(/does not support session resume/i);
        expect(h.db.select().from(schema.runs).all().length).toBe(0);
        expect(submitSpy).not.toHaveBeenCalled();
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });
  });

  describe("agent/model resolution ladder", () => {
    test("input agent wins over the project default", async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        // Project defaults to codex, but the submit input pins claude-code.
        const projectId = await seedProject(h, { agent: "codex" });
        const { runId } = await submitRun(deps(h), { projectId, agent: "claude-code" });

        const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        expect(run?.agentName).toBe("claude-code");
        expect(submitSpy).toHaveBeenCalledTimes(1);
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });

    test("falls back to the project's agent + model when input and task carry none", async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        // Codex auth present so the project-default codex agent passes the probe.
        writeCodexAuth();
        const projectId = await seedProject(h, { agent: "codex", model: "gpt-5.5" });
        const { runId } = await submitRun(deps(h), { projectId });

        const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        expect(run?.agentName).toBe("codex");
        expect(run?.model).toBe("gpt-5.5");
        expect(submitSpy).toHaveBeenCalledTimes(1);
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });

    test("defaults to claude-code when no input/task/project/settings agent is set", async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        const projectId = await seedProject(h); // agent null everywhere
        const { runId } = await submitRun(deps(h), { projectId });

        const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        expect(run?.agentName).toBe("claude-code");
        expect(run?.model).toBeNull();
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });
  });
});
