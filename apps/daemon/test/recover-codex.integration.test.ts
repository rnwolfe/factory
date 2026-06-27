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
 * Codex orphan-recovery parity test (codex-parity §6b).
 *
 * Pins the contract: an orphaned run whose `agentName='codex'` and whose
 * persisted log carries a codex-shape stream (`item.completed` events with
 * `item.type='agent_message'`) must recover identically to the claude-code
 * case — flip the row to the declared status, persist questions, and
 * surface a `blocked_run` decision.
 *
 * Without dispatching on `agentName`, the previous claude-only parser would
 * see zero text in a codex log and quietly mark the run `aborted`, hiding
 * the agent's actual declaration.
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
  const root = mkdtempSync(path.join(tmpdir(), "factory-recover-codex-"));
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
    githubReplyAllowlist: [],
    publicBaseUrl: null,
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

function seedProject(h: Harness, slug = "recover-codex"): { id: string; workdirPath: string } {
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
 * Write a codex-shape log: `thread.started` + one `item.completed` carrying
 * an `agent_message` whose text embeds the factory-status footer. Mirrors
 * what `codex exec --json` actually emits.
 */
function writeCodexLog(workdirPath: string, runId: string, factoryStatusBody: string): void {
  const dir = path.join(workdirPath, ".factory", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const text = `Did the work.\n\n\`\`\`factory-status\n${factoryStatusBody}\n\`\`\``;
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "th_codex_orphan" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }),
  ];
  writeFileSync(path.join(dir, "log.txt"), `${lines.join("\n")}\n`);
}

describe("reapOrphanedRuns · codex log shape", () => {
  test("codex-shape blocked run flips status + surfaces inbox decision", async () => {
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
          taskId: "task-codex",
          status: "running",
          agentName: "codex",
          branch,
          worktreePath: path.join(h.root, "worktrees", project.id, runId),
          startedAt,
          budgetSeconds: 0,
        })
        .run();

      writeCodexLog(
        project.workdirPath,
        runId,
        JSON.stringify({
          status: "blocked",
          summary: "Need clarification on the data shape before I can proceed.",
          questions: ["Is the input array always non-empty?"],
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

      const row = h.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
      expect(row?.status).toBe("blocked");
      expect(row?.summary).toContain("clarification");
      const questions = JSON.parse(row?.blockerQuestions ?? "[]") as string[];
      expect(questions).toContain("Is the input array always non-empty?");

      const decisions = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.projectId, project.id))
        .all();
      expect(decisions.length).toBe(1);
      expect(decisions[0]?.kind).toBe("blocked_run");

      const inboxEvents = h.published.filter(
        (e) => e.channel === "inbox" && e.kind === "decision_created",
      );
      expect(inboxEvents.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("codex-shape done run is recovered as completed, no decision surfaced", async () => {
    const h = setupHarness();
    try {
      const project = seedProject(h);
      const runId = createId();

      h.db
        .insert(schema.runs)
        .values({
          id: runId,
          projectId: project.id,
          taskId: "task-codex-done",
          status: "running",
          agentName: "codex",
          branch: `factory/run-${runId}`,
          worktreePath: path.join(h.root, "worktrees", project.id, runId),
          startedAt: Date.now() - 1000,
          budgetSeconds: 0,
        })
        .run();

      writeCodexLog(
        project.workdirPath,
        runId,
        JSON.stringify({ status: "done", summary: "Landed it." }),
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
    } finally {
      h.cleanup();
    }
  });
});
