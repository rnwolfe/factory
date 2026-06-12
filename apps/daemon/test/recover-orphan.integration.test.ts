import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { reapOrphanedRuns } from "../src/workers/recover.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Cover the daemon-restart recovery path. Specifically: a `running` run
 * left over from a prior daemon process whose persisted log carries a
 * `factory-status` blocked block must (a) flip the run row to `blocked`
 * with the parsed summary + questions and (b) materialize a `blocked_run`
 * decision in the inbox. Without (b), recovered blocks silently
 * disappear from the operator's only attention sink — that's the bug we
 * hit on `du6oszbi1hgj` and the reason this test exists.
 */

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  published: DaemonEvent[];
  runs: RunRegistry;
  pool: WorkerPool;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-recover-test-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
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
    agentBudgetSeconds: 0,
    gitAuthor: { name: "test", email: "t@t" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    events,
    published,
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

function seedProject(h: Harness, slug = "recover-demo"): { id: string; workdirPath: string } {
  const id = createId();
  const now = Date.now();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });
  h.db
    .insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return { id, workdirPath };
}

/**
 * Write a stream-json log identical in shape to what claude --print
 * produces. Each `assistant` line carries one or more text deltas; we
 * embed the full factory-status block so the recover path's parser
 * sees it.
 */
function writeAgentLog(workdirPath: string, runId: string, factoryStatusBody: string): void {
  const dir = path.join(workdirPath, ".factory", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const text = `Doing the work…\n\n\`\`\`factory-status\n${factoryStatusBody}\n\`\`\``;
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
  ];
  writeFileSync(path.join(dir, "log.txt"), `${lines.join("\n")}\n`);
}

describe("reapOrphanedRuns · blocked recovery surfaces a decision", () => {
  test("blocked-from-log run flips status, persists questions, and creates inbox decision", async () => {
    const h = setupHarness();
    try {
      const project = seedProject(h);
      const runId = createId();
      const branch = `factory/run-${runId}`;
      const startedAt = Date.now() - 60_000;

      h.db
        .insert(schema.runs)
        .values({
          id: runId,
          projectId: project.id,
          taskId: "task-007",
          status: "running",
          agentName: "claude-code",
          branch,
          worktreePath: path.join(h.root, "worktrees", project.id, runId),
          startedAt,
          budgetSeconds: 0,
        })
        .run();

      writeAgentLog(
        project.workdirPath,
        runId,
        JSON.stringify({
          status: "blocked",
          summary: "Need M21 raw export path before the corpus build can proceed.",
          questions: [
            "Where is the M21 raw export?",
            "Should OCR fallback be enabled for malformed pages?",
          ],
          acceptance: [
            { criterion: "20000+ chunks ingested", met: false, reason: "blocked on raw input" },
          ],
        }),
      );

      const stats = await reapOrphanedRuns({
        config: h.config,
        db: h.db,
        events: h.events,
        runs: h.runs,
        pool: h.pool,
      });

      expect(stats).toEqual({ recovered: 1, resumed: 0, aborted: 0 });

      const recoveredRow = h.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
      expect(recoveredRow?.status).toBe("blocked");
      expect(recoveredRow?.summary).toContain("M21 raw export");
      expect(recoveredRow?.endedAt).toBeGreaterThan(startedAt);
      expect(recoveredRow?.blockerQuestions).toBeTruthy();
      const persistedQuestions = JSON.parse(recoveredRow?.blockerQuestions ?? "[]") as string[];
      expect(persistedQuestions).toContain("Where is the M21 raw export?");
      expect(persistedQuestions.some((q) => q.startsWith("Unmet acceptance —"))).toBe(true);
      expect(recoveredRow?.acceptanceResults).toBeTruthy();

      const decisions = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.projectId, project.id))
        .all();
      expect(decisions.length).toBe(1);
      const decision = decisions[0];
      expect(decision?.kind).toBe("blocked_run");
      expect(decision?.status).toBe("pending");
      const payload = decision?.payload as {
        runId: string;
        taskId: string | null;
        questions: string[];
        branch: string;
      };
      expect(payload.runId).toBe(runId);
      expect(payload.taskId).toBe("task-007");
      expect(payload.branch).toBe(branch);
      expect(payload.questions.length).toBeGreaterThanOrEqual(2);

      const inboxEvents = h.published.filter(
        (e) => e.channel === "inbox" && e.kind === "decision_created",
      );
      expect(inboxEvents.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("completed-from-log run does NOT create a decision", async () => {
    const h = setupHarness();
    try {
      const project = seedProject(h);
      const runId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: runId,
          projectId: project.id,
          taskId: "task-008",
          status: "running",
          agentName: "claude-code",
          branch: `factory/run-${runId}`,
          worktreePath: path.join(h.root, "worktrees", project.id, runId),
          startedAt: Date.now() - 1000,
          budgetSeconds: 0,
        })
        .run();

      writeAgentLog(
        project.workdirPath,
        runId,
        JSON.stringify({
          status: "done",
          summary: "Shipped the small refactor cleanly.",
          questions: [],
          acceptance: [],
        }),
      );

      const stats = await reapOrphanedRuns({
        config: h.config,
        db: h.db,
        events: h.events,
        runs: h.runs,
        pool: h.pool,
      });
      expect(stats.recovered).toBe(1);

      const decisions = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.projectId, project.id))
        .all();
      expect(decisions.length).toBe(0);

      const inboxEvents = h.published.filter(
        (e) => e.channel === "inbox" && e.kind === "decision_created",
      );
      expect(inboxEvents.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
