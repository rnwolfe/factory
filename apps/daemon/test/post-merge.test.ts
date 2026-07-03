import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";

import { AUTONOMY_PRESETS } from "../src/autonomy/config.ts";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import type { InvokeClaudeResult } from "../src/plans/invoke-claude.ts";
import { listTasks } from "../src/projects/tasks.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { applyPostMergeRunOutcome } from "../src/workers/post-merge.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Focused unit tests for the auto-advance decision in
 * `applyPostMergeRunOutcome`. The integration suites
 * (`merge-failure-approve`, `post-merge-race`) exercise the full merge →
 * reconcile → advance chain against a live runner; these isolate the
 * branch logic by stubbing execution at the worker-pool seam:
 * `pool.submit` is spied to a no-op so the auto-advance `submitRun` still
 * inserts its `queued` run row (observable) but `executeRun` — and any
 * real tmux/agent spawn — never fires.
 */

// Defensive: nothing here reaches tmux (pool.submit is stubbed), but pin a
// throwaway socket per CLAUDE.md so a stray call could never touch the
// operator's default server.
process.env.FACTORY_TMUX_SOCKET = `factory-test-postmerge-${process.pid}`;

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
  const root = mkdtempSync(path.join(tmpdir(), "factory-post-merge-unit-"));
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

interface SeedTask {
  id: string;
  status: "ready" | "done" | "blocked";
  blockedBy?: string[];
}

interface SeedOpts {
  tasks: SeedTask[];
  /** id of the task the just-finished run completed. Seeded `done` on main. */
  justFinishedId: string;
  autoAdvance?: boolean;
  /** Status of the run row applyPostMergeRunOutcome is called with. */
  runStatus?: (typeof schema.runStatusEnum)[number];
  /** Raw JSON to store in projects.autonomyConfig (e.g. a preset blob). */
  autonomyConfig?: string | null;
  /** Commit a docs/internal/SPEC.md so proposeMilestone has something to read. */
  withSpec?: boolean;
}

interface SeedResult {
  projectId: string;
  workdirPath: string;
  runId: string;
}

function taskFileBody(t: SeedTask): string {
  const lines = [`---`, `id: ${t.id}`, `title: ${t.id}`, `status: ${t.status}`];
  if (t.blockedBy && t.blockedBy.length > 0) {
    lines.push(`blockedBy:`);
    for (const dep of t.blockedBy) lines.push(`  - ${dep}`);
  }
  lines.push(`---`, ``, `body`, ``);
  return lines.join("\n");
}

async function seedProject(h: Harness, opts: SeedOpts): Promise<SeedResult> {
  const slug = "post-merge-unit";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });

  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);

  await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
  for (const t of opts.tasks) {
    await writeFile(
      path.join(workdirPath, ".factory", "work", `${t.id}-demo.md`),
      taskFileBody(t),
      "utf8",
    );
  }
  if (opts.withSpec) {
    await mkdir(path.join(workdirPath, "docs", "internal"), { recursive: true });
    await writeFile(
      path.join(workdirPath, "docs", "internal", "SPEC.md"),
      "# Spec\n\n## Milestone-gated build order\n- M0 — spike\n- M1 — onboarding\n",
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
      autoAdvance: opts.autoAdvance ?? true,
      autonomyConfig: opts.autonomyConfig ?? null,
      model: null,
      archivedAt: null,
    })
    .run();

  const runId = createId();
  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: opts.justFinishedId,
      status: opts.runStatus ?? "completed",
      agentName: "claude-code",
      branch: `factory/run-${runId}`,
      worktreePath: path.join(h.root, "worktrees", slug, runId),
      startedAt: now - 60_000,
      endedAt: now - 1_000,
      budgetSeconds: 0,
      summary: "done",
    })
    .run();

  return { projectId, workdirPath, runId };
}

function runsForTask(h: Harness, projectId: string, taskId: string) {
  return h.db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.taskId, taskId)))
    .all();
}

type AgentInvoker = (prompt: string) => Promise<InvokeClaudeResult>;

function callPostMerge(h: Harness, runId: string, agentInvoker?: AgentInvoker) {
  return applyPostMergeRunOutcome(
    { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool, agentInvoker },
    runId,
  );
}

/** Seed the active milestone-decompose prompt `proposeMilestone` reads. */
function seedMilestonePrompt(h: Harness): void {
  h.db
    .insert(schema.prompts)
    .values({
      id: "p-milestone",
      promptKey: "spec-decompose-milestone-v1",
      version: 1,
      content: "ceremony={{INTENT_CEREMONY}} target={{TARGET_MILESTONE}}\n{{SPEC_MARKDOWN}}",
      active: true,
      createdAt: Date.now(),
    })
    .run();
}

/** Preset override blobs, verbatim from AUTONOMY_PRESETS (what applyPreset stores). */
const HANDS_OFF_CONFIG = JSON.stringify(AUTONOMY_PRESETS["hands-off"]);
const BALANCED_CONFIG = JSON.stringify(AUTONOMY_PRESETS.balanced);
const CONSERVATIVE_CONFIG = JSON.stringify(AUTONOMY_PRESETS.conservative);

/** An agent reply carrying a non-empty milestone decomposition. */
function decompositionInvoker(taskTitle = "Auto-planned task"): AgentInvoker {
  return async () => ({
    text: JSON.stringify({
      milestone: "M1",
      summary: "next milestone",
      tasks: [{ title: taskTitle, estimate: "small", acceptance: ["it works"] }],
      unknowns: [],
      risks: [],
      firstTaskNote: "",
      roadmap: [{ id: "M1", title: "Onboarding", goal: "ideation" }],
    }),
    sessionId: null,
    metrics: null,
  });
}

describe("applyPostMergeRunOutcome · auto-advance", () => {
  test("auto-advance on + a ready next task → submits the next task", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      // submitRun inserted a queued run row for the next ready task...
      const next = runsForTask(h, seed.projectId, "task-002");
      expect(next.length).toBe(1);
      expect(next[0]?.status).toBe("queued");
      // ...and it went through the pool (execution stubbed).
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("another run already queued on the project → no submit (no double-fire)", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      // Operator (or a prior helper invocation) already advanced.
      const preexistingId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: preexistingId,
          projectId: seed.projectId,
          taskId: "task-002",
          status: "queued",
          agentName: "claude-code",
          branch: `factory/run-${preexistingId}`,
          worktreePath: path.join(h.root, "worktrees", "post-merge-unit", preexistingId),
          startedAt: Date.now(),
          budgetSeconds: 0,
        })
        .run();

      await callPostMerge(h, seed.runId);

      // Only the pre-existing run for task-002 — helper did not double-submit.
      const task002 = runsForTask(h, seed.projectId, "task-002");
      expect(task002.length).toBe(1);
      expect(task002[0]?.id).toBe(preexistingId);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("source run not `completed` (merge-failure hold) → no advance", async () => {
    // The runner holds auto-advance on a merge failure by not invoking this
    // helper while `mergeFailureNote` is set (runner.ts). At the unit level the
    // guard is `run.status !== 'completed'`: a run left non-terminal (e.g.
    // `blocked`) must never advance the queue.
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        runStatus: "blocked",
        tasks: [
          { id: "task-001", status: "blocked" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("next task blocked by an unfinished dependency → skipped, next startable picked (ADR-019)", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      // task-002 is `ready` but blocked by task-099 (still ready, not terminal)
      // → not startable. task-003 is startable and must be picked instead.
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready", blockedBy: ["task-099"] },
          { id: "task-003", status: "ready" },
          { id: "task-099", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      const picked = runsForTask(h, seed.projectId, "task-003");
      expect(picked.length).toBe(1);
      expect(picked[0]?.status).toBe("queued");
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("empty ready queue → no submit, and a queue-empty nudge is emitted", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      // Enable the (default-off) queue-empty nudge so the drain signal is observable.
      h.db
        .insert(schema.settings)
        .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
        .run();

      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          // No later ready task — the queue is drained.
          { id: "task-000", status: "ready" },
        ],
      });

      const inbox: string[] = [];
      h.events.subscribe((e) => {
        if (e.channel === "inbox") inbox.push(e.kind);
      });

      await callPostMerge(h, seed.runId);

      // No run submitted (nothing ready after task-001; pickNextReadyTask does
      // not wrap back to the earlier task-000).
      expect(submitSpy).not.toHaveBeenCalled();
      // A queue-empty nudge decision was recorded and surfaced to the inbox.
      const nudges = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "queue_empty"),
          ),
        )
        .all();
      expect(nudges.length).toBe(1);
      expect(nudges[0]?.status).toBe("pending");
      expect(inbox).toContain("decision_created");
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("auto-advance off → no submit even with a ready next task", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: false,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });
});

/**
 * An agent reply whose decomposition EXCEEDS the "contained" blast-radius bar —
 * a `large`-estimate task. Structurally valid, non-empty, but not auto-confirmable.
 */
function broadDecompositionInvoker(): AgentInvoker {
  return async () => ({
    text: JSON.stringify({
      milestone: "M1",
      summary: "next milestone",
      tasks: [{ title: "Rebuild the auth subsystem", estimate: "large", acceptance: ["it works"] }],
      unknowns: [],
      risks: [],
      firstTaskNote: "",
      roadmap: [{ id: "M1", title: "Onboarding", goal: "ideation" }],
    }),
    sessionId: null,
    metrics: null,
  });
}

describe("applyPostMergeRunOutcome · hands-off auto-plan on queue drain", () => {
  // Criteria 1 + 3: hands-off preset + auto-advance → on drain, confirmMilestone
  // runs with no PWA interaction, and the new task is picked up by the chain.
  test("hands-off + drained queue → auto-plans a milestone and starts it", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      // Surface any drain nudge, to prove we DON'T fall back to it.
      h.db
        .insert(schema.settings)
        .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
        .run();
      seedMilestonePrompt(h);

      const seed = await seedProject(h, {
        autoAdvance: true,
        autonomyConfig: HANDS_OFF_CONFIG,
        withSpec: true,
        justFinishedId: "task-001",
        // No later ready task — the queue is drained.
        tasks: [{ id: "task-001", status: "done" }],
      });

      await callPostMerge(h, seed.runId, decompositionInvoker("Build the router"));

      // confirmMilestone created the milestone task (committed on main), no PWA.
      const tasks = await listTasks({ workdirPath: seed.workdirPath, taskBackend: "file" });
      const planned = tasks.filter((t) => t.frontmatter.labels?.includes("milestone-task"));
      expect(planned).toHaveLength(1);
      expect(planned[0]?.frontmatter.title).toBe("Build the router");
      expect(planned[0]?.frontmatter.milestone).toBe("M1");

      // ...and the existing auto-advance chain immediately started it.
      expect(submitSpy).toHaveBeenCalledTimes(1);
      const startedId = planned[0]?.id;
      if (!startedId) throw new Error("no planned task id");
      const started = runsForTask(h, seed.projectId, startedId);
      expect(started.length).toBe(1);
      expect(started[0]?.status).toBe("queued");

      // No queue-empty nudge — the loop stayed hands-off.
      const nudges = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "queue_empty"),
          ),
        )
        .all();
      expect(nudges.length).toBe(0);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  // Criterion 2: conservative/balanced presets keep the manual nudge behavior.
  for (const [label, config] of [
    ["balanced", BALANCED_CONFIG],
    ["conservative", CONSERVATIVE_CONFIG],
  ] as const) {
    test(`${label} preset + drained queue → nudges, never auto-plans`, async () => {
      const h = setupHarness();
      const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
      try {
        h.db
          .insert(schema.settings)
          .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
          .run();
        seedMilestonePrompt(h);

        const seed = await seedProject(h, {
          autoAdvance: true,
          autonomyConfig: config,
          withSpec: true,
          justFinishedId: "task-001",
          tasks: [{ id: "task-001", status: "done" }],
        });

        // Invoker that WOULD plan tasks — proves it's never called off-preset.
        let invoked = false;
        const invoker: AgentInvoker = async (p) => {
          invoked = true;
          return decompositionInvoker()(p);
        };
        await callPostMerge(h, seed.runId, invoker);

        expect(invoked).toBe(false);
        expect(submitSpy).not.toHaveBeenCalled();
        // Only the pre-seeded task-001; no milestone task was created.
        const tasks = await listTasks({ workdirPath: seed.workdirPath, taskBackend: "file" });
        expect(tasks.filter((t) => t.frontmatter.labels?.includes("milestone-task"))).toHaveLength(
          0,
        );
        // The unchanged manual nudge fired.
        const nudges = h.db
          .select()
          .from(schema.decisions)
          .where(
            and(
              eq(schema.decisions.projectId, seed.projectId),
              eq(schema.decisions.kind, "queue_empty"),
            ),
          )
          .all();
        expect(nudges.length).toBe(1);
        expect(nudges[0]?.status).toBe("pending");
      } finally {
        submitSpy.mockRestore();
        h.cleanup();
      }
    });
  }

  // Criterion 2: a decomposition that EXCEEDS the contained blast-radius bar is
  // NOT auto-confirmed — it's left for manual review (the queue-empty nudge),
  // matching pre-existing manual-confirm behavior. Same hands-off preset as the
  // auto-confirm test above; only the decomposition's blast radius differs.
  test("hands-off but broad decomposition → not auto-confirmed, falls back to nudge", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      h.db
        .insert(schema.settings)
        .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
        .run();
      seedMilestonePrompt(h);

      const seed = await seedProject(h, {
        autoAdvance: true,
        autonomyConfig: HANDS_OFF_CONFIG,
        withSpec: true,
        justFinishedId: "task-001",
        tasks: [{ id: "task-001", status: "done" }],
      });

      await callPostMerge(h, seed.runId, broadDecompositionInvoker());

      // No milestone task was created — the broad decomposition was held back.
      expect(submitSpy).not.toHaveBeenCalled();
      const tasks = await listTasks({ workdirPath: seed.workdirPath, taskBackend: "file" });
      expect(tasks.filter((t) => t.frontmatter.labels?.includes("milestone-task"))).toHaveLength(0);
      // …and the manual queue-empty nudge fired, so the operator can review/confirm.
      const nudges = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "queue_empty"),
          ),
        )
        .all();
      expect(nudges.length).toBe(1);
      expect(nudges[0]?.status).toBe("pending");
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  // Precondition: an EMPTY decomposition is not confirmed — falls back to nudge.
  test("hands-off but empty decomposition → no tasks, falls back to nudge", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      h.db
        .insert(schema.settings)
        .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
        .run();
      seedMilestonePrompt(h);

      const seed = await seedProject(h, {
        autoAdvance: true,
        autonomyConfig: HANDS_OFF_CONFIG,
        withSpec: true,
        justFinishedId: "task-001",
        tasks: [{ id: "task-001", status: "done" }],
      });

      const emptyInvoker: AgentInvoker = async () => ({
        text: JSON.stringify({ milestone: "M1", tasks: [], roadmap: [] }),
        sessionId: null,
        metrics: null,
      });
      await callPostMerge(h, seed.runId, emptyInvoker);

      expect(submitSpy).not.toHaveBeenCalled();
      const tasks = await listTasks({ workdirPath: seed.workdirPath, taskBackend: "file" });
      expect(tasks.filter((t) => t.frontmatter.labels?.includes("milestone-task"))).toHaveLength(0);
      const nudges = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "queue_empty"),
          ),
        )
        .all();
      expect(nudges.length).toBe(1);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });
});
