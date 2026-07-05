import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, METRICS_PORTFOLIO, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";
import { METRIC_CATALOG } from "../src/metrics/catalog.ts";
import { dayKey, floorToUtcDay, rollupDay } from "../src/metrics/rollup.ts";

/**
 * Whole-catalog fixture coverage (task acceptance #1). Every entry in
 * METRIC_CATALOG is computed through the real rollup against a hand-seeded DB —
 * including two real git repos so the git-flow metrics (`commits`, `loc_added`,
 * `loc_removed`) assert actual counts, not the "null for a non-repo" skip the
 * older suites relied on. Values are asserted at BOTH portfolio and project
 * scope. The `missing` guard fails the instant a new metric is added to the
 * catalog without a matching fixture expectation, so coverage can't silently rot.
 */

const DAY_START = floorToUtcDay(Date.parse("2026-06-20T00:00:00Z"));
const MID = DAY_START + 12 * 3_600_000; // noon UTC — every in-window timestamp lands here
const BEFORE = DAY_START - 5_000; // just before the window opens → must never count

type Db = ReturnType<typeof createDb>;

/** Per-metric expected values. `p` = portfolio; `a`/`b` = the two projects. */
interface Expect {
  p: number;
  a?: number;
  b?: number;
}

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** A commit that writes `files` and dates itself at noon-in-window. */
interface Commit {
  files: Record<string, string>;
  removeFiles?: string[];
}

/** Create a git repo whose commits all land at MID (inside the rollup window). */
async function initRepo(commits: Commit[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-git-"));
  await git(["init", "-q", "-b", "main"], root);
  await git(["config", "user.name", "t"], root);
  await git(["config", "user.email", "t@t"], root);
  const when = `${Math.floor(MID / 1000)} +0000`; // git's raw "<unixtime> <tz>" format
  for (const c of commits) {
    for (const [rel, content] of Object.entries(c.files)) {
      writeFileSync(path.join(root, rel), content);
    }
    for (const rel of c.removeFiles ?? []) {
      await git(["rm", "-q", rel], root);
    }
    await git(["add", "-A"], root);
    await git(["commit", "-q", "-m", "c"], root, {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  }
  return root;
}

function seedProject(
  db: Db,
  slug: string,
  autonomyMode: "collaborative" | "autonomous",
  workdirPath: string,
): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ceremony: "personal",
      workdirPath,
      autonomyMode,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

function seedRun(
  db: Db,
  projectId: string,
  status: "completed" | "failed",
  startedAt: number,
  retryOfRunId?: string,
): string {
  const id = createId();
  db.insert(schema.runs)
    .values({
      id,
      projectId,
      status,
      branch: "factory/run-x",
      worktreePath: "/tmp/wt",
      startedAt,
      endedAt: startedAt + 1000,
      budgetSeconds: 60,
      retryOfRunId: retryOfRunId ?? null,
    })
    .run();
  return id;
}

function seedDecision(
  db: Db,
  projectId: string | null,
  status: "pending" | "auto_ratified",
  createdAt: number,
): void {
  db.insert(schema.decisions)
    .values({
      id: createId(),
      kind: "agent_decision",
      projectId,
      outcome: "decided: x",
      payload: { id: "d", decided: "x" },
      status,
      createdAt,
    })
    .run();
}

/**
 * Seed a `merge_failure` decision the way `recordMergeFailure` + the resolution
 * sites do: reason + captured lever values in the payload, and a resolution-path
 * outcome once actioned. Drives the `merge_failures_*` catalog metrics.
 */
function seedMergeFailure(
  db: Db,
  projectId: string,
  opts: {
    reason: "dirty" | "conflict" | "other";
    status: "pending" | "actioned" | "dismissed";
    outcome: string;
    dirtyAutoReset: boolean;
    conflictAutoResolve: boolean;
    createdAt: number;
  },
): void {
  db.insert(schema.decisions)
    .values({
      id: createId(),
      kind: "merge_failure",
      projectId,
      outcome: opts.outcome,
      payload: {
        runId: createId(),
        branch: "factory/run-x",
        reason: opts.reason,
        message: "merge refused",
        levers: {
          dirtyAutoReset: opts.dirtyAutoReset,
          conflictAutoResolve: opts.conflictAutoResolve,
        },
      },
      status: opts.status,
      actionedAt: opts.status === "pending" ? null : opts.createdAt,
      createdAt: opts.createdAt,
    })
    .run();
}

function seedAutonomyEvent(
  db: Db,
  projectId: string | null,
  kind: string,
  createdAt: number,
): void {
  db.insert(schema.autonomyEvents)
    .values({ id: createId(), projectId, kind, message: "x", createdAt })
    .run();
}

/**
 * Seed an `audits` row. `startedAt` drives `audits_started`; a non-null
 * `completedAt` + terminal `status` drive `audits_completed` / `audits_failed`.
 */
function seedAudit(
  db: Db,
  projectId: string,
  opts: {
    status: "running" | "completed" | "reviewed" | "approved" | "rejected" | "failed";
    startedAt: number;
    completedAt?: number;
  },
): void {
  db.insert(schema.audits)
    .values({
      id: createId(),
      projectId,
      skillName: "docs-audit",
      skillVersion: "abc123",
      status: opts.status,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt ?? null,
    })
    .run();
}

function seedWatchObservation(db: Db, createdAt: number): void {
  db.insert(schema.watchObservations)
    .values({
      id: createId(),
      kind: "candidate-task",
      title: "t",
      detail: "d",
      evidence: "[]",
      proposal: "note-only",
      dedupeKey: createId(),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

/** Read a rolled-up metric for the fixed DAY_START day; undefined = no row. */
function metric(db: Db, projectId: string, key: string): number | undefined {
  return db
    .select({ v: schema.metricsDaily.value })
    .from(schema.metricsDaily)
    .where(
      and(
        eq(schema.metricsDaily.date, dayKey(DAY_START)),
        eq(schema.metricsDaily.projectId, projectId),
        eq(schema.metricsDaily.metric, key),
      ),
    )
    .get()?.v;
}

describe("METRIC_CATALOG fixture coverage (every metric, both scopes)", () => {
  test("every catalog metric matches hand-verified counts at portfolio + project scope", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "metrics-cov-"));
    // alpha: 1 commit adding 3 lines. beta: 2 commits — +5 lines, then +2/-1.
    const alphaRepo = await initRepo([{ files: { "a.ts": "l1\nl2\nl3\n" } }]);
    const betaRepo = await initRepo([
      { files: { "b1.ts": "l1\nl2\nl3\nl4\nl5\n" } }, // +5
      { files: { "b1.ts": "l1\nl2\nl3\nl4\n", "b2.ts": "x1\nx2\n" } }, // b1: -1, b2: +2
    ]);
    try {
      const dbPath = path.join(root, "data.db");
      runMigrations(dbPath);
      const db = createDb(dbPath);

      const alpha = seedProject(db, "alpha", "collaborative", alphaRepo);
      const beta = seedProject(db, "beta", "autonomous", betaRepo);

      // ── runs: alpha 2 completed + 1 failed + 1 completed-retry; beta 1 completed.
      seedRun(db, alpha, "completed", MID);
      seedRun(db, alpha, "completed", MID + 1_000);
      const failed = seedRun(db, alpha, "failed", MID + 2_000);
      seedRun(db, alpha, "completed", MID + 3_000, failed); // a retry that self-healed
      seedRun(db, beta, "completed", MID + 4_000);
      seedRun(db, alpha, "completed", BEFORE); // out of window → excluded

      // ── decisions: alpha pending+auto; beta auto; one portfolio-only (null project).
      seedDecision(db, alpha, "pending", MID);
      seedDecision(db, alpha, "auto_ratified", MID + 1_000);
      seedDecision(db, beta, "auto_ratified", MID + 2_000);
      seedDecision(db, null, "auto_ratified", MID + 3_000); // portfolio-only (the 07-01 shape)
      seedDecision(db, alpha, "auto_ratified", BEFORE); // out of window → excluded

      // ── merge failures (feature plan mnx1zt27): distinct per-scope reason /
      //    resolution-path / lever mixes so a mis-keyed compute can't pass.
      //    alpha: dirty→auto-reset (lever on), conflict→operator (lever off),
      //           dirty→unresolved (lever off).
      seedMergeFailure(db, alpha, {
        reason: "dirty",
        status: "actioned",
        outcome: "merge:dirty-auto-reset",
        dirtyAutoReset: true,
        conflictAutoResolve: false,
        createdAt: MID,
      });
      seedMergeFailure(db, alpha, {
        reason: "conflict",
        status: "actioned",
        outcome: "merge:conflict-resolved",
        dirtyAutoReset: false,
        conflictAutoResolve: false,
        createdAt: MID + 1_000,
      });
      seedMergeFailure(db, alpha, {
        reason: "dirty",
        status: "pending",
        outcome: "merge:dirty",
        dirtyAutoReset: false,
        conflictAutoResolve: false,
        createdAt: MID + 2_000,
      });
      //    beta: conflict→auto-resolve (lever on), conflict→manual tmux (lever off),
      //          dirty→operator approved-retry (lever off).
      seedMergeFailure(db, beta, {
        reason: "conflict",
        status: "actioned",
        outcome: "merge:conflict-auto-resolved",
        dirtyAutoReset: true,
        conflictAutoResolve: true,
        createdAt: MID,
      });
      seedMergeFailure(db, beta, {
        reason: "conflict",
        status: "actioned",
        outcome: "merge:manual-intervention",
        dirtyAutoReset: false,
        conflictAutoResolve: false,
        createdAt: MID + 1_000,
      });
      seedMergeFailure(db, beta, {
        reason: "dirty",
        status: "actioned",
        outcome: "merge:approved-retry",
        dirtyAutoReset: false,
        conflictAutoResolve: false,
        createdAt: MID + 2_000,
      });
      seedMergeFailure(db, alpha, {
        reason: "dirty",
        status: "actioned",
        outcome: "merge:dirty-auto-reset",
        dirtyAutoReset: true,
        conflictAutoResolve: false,
        createdAt: BEFORE, // out of window → excluded
      });

      // ── autonomy events: distinct (alpha,beta) counts per kind so a mis-keyed
      //    compute can't accidentally pass.
      const evs: Array<[string, number, number]> = [
        ["trust_contracted", 1, 1],
        ["trust_promoted", 1, 2],
        ["gate_held", 2, 1],
        ["auto_merged", 1, 3],
        ["auto_ran", 3, 1],
        ["auto_retried", 2, 2],
        ["auto_retry_exhausted", 1, 1],
      ];
      for (const [kind, na, nb] of evs) {
        for (let i = 0; i < na; i++) seedAutonomyEvent(db, alpha, kind, MID);
        for (let i = 0; i < nb; i++) seedAutonomyEvent(db, beta, kind, MID);
      }
      seedAutonomyEvent(db, alpha, "trust_contracted", BEFORE); // out of window → excluded

      // ── watch observations: 3 in window, 1 out.
      seedWatchObservation(db, MID);
      seedWatchObservation(db, MID + 1_000);
      seedWatchObservation(db, MID + 2_000);
      seedWatchObservation(db, BEFORE); // out of window → excluded

      // ── audits: alpha 4 started (2 completed, 1 failed, 1 still running) plus
      //    one that STARTED before the window but COMPLETED inside it (proves
      //    audits_completed anchors on completed_at, not started_at) and one
      //    fully-excluded row. beta: 1 completed + 1 failed.
      seedAudit(db, alpha, { status: "completed", startedAt: MID, completedAt: MID });
      seedAudit(db, alpha, {
        status: "approved",
        startedAt: MID + 1_000,
        completedAt: MID + 1_000,
      });
      seedAudit(db, alpha, { status: "failed", startedAt: MID + 2_000, completedAt: MID + 2_000 });
      seedAudit(db, alpha, { status: "running", startedAt: MID + 3_000 }); // in-flight
      seedAudit(db, alpha, { status: "completed", startedAt: BEFORE, completedAt: MID + 4_000 });
      seedAudit(db, alpha, { status: "completed", startedAt: BEFORE, completedAt: BEFORE }); // excluded
      seedAudit(db, beta, { status: "completed", startedAt: MID, completedAt: MID });
      seedAudit(db, beta, { status: "failed", startedAt: MID + 1_000, completedAt: MID + 1_000 });

      await rollupDay(db, DAY_START);

      const expected: Record<string, Expect> = {
        // throughput
        runs_total: { p: 5, a: 4, b: 1 },
        runs_completed: { p: 4, a: 3, b: 1 },
        runs_failed: { p: 1, a: 1, b: 0 },
        // decisions — portfolio (10) exceeds alpha(5)+beta(4): the null-project
        // decision counts only at portfolio (the 07-01 case). Each scope's total
        // includes its merge_failure decisions (3 per project, in window).
        decisions_total: { p: 10, a: 5, b: 4 },
        auto_ratified_total: { p: 3, a: 1, b: 1 },
        // git flow — real repos
        commits: { p: 3, a: 1, b: 2 },
        loc_added: { p: 10, a: 3, b: 7 },
        loc_removed: { p: 1, a: 0, b: 1 },
        // portfolio-only snapshots
        active_projects: { p: 2 },
        projects_collaborative: { p: 1 },
        projects_autonomous: { p: 1 },
        watch_observations_created: { p: 3 },
        // audit primitive activity — started anchors on started_at, completed /
        // failed on completed_at. alpha's before→in-window completion counts in
        // completed but not started.
        audits_started: { p: 6, a: 4, b: 2 },
        audits_completed: { p: 4, a: 3, b: 1 },
        audits_failed: { p: 2, a: 1, b: 1 },
        // autonomy events
        autonomy_contractions: { p: 2, a: 1, b: 1 },
        autonomy_promotions: { p: 3, a: 1, b: 2 },
        autonomy_gate_held: { p: 3, a: 2, b: 1 },
        autonomy_auto_merged: { p: 4, a: 1, b: 3 },
        autonomy_auto_ran: { p: 4, a: 3, b: 1 },
        // auto-retry loop
        auto_retries: { p: 4, a: 2, b: 2 },
        auto_retry_exhausted: { p: 2, a: 1, b: 1 },
        auto_retry_resolved: { p: 1, a: 1, b: 0 },
        // merge failures (feature plan mnx1zt27) — total = Σ(reasons) = Σ(paths)
        //   = Σ(lever on/off) for every scope.
        merge_failures_total: { p: 6, a: 3, b: 3 },
        merge_failures_dirty: { p: 3, a: 2, b: 1 },
        merge_failures_conflict: { p: 3, a: 1, b: 2 },
        merge_failures_resolved_auto_dirty_reset: { p: 1, a: 1, b: 0 },
        merge_failures_resolved_auto_agent_resolve: { p: 1, a: 0, b: 1 },
        merge_failures_resolved_operator_agent_resolve: { p: 2, a: 1, b: 1 },
        merge_failures_resolved_manual_tmux: { p: 1, a: 0, b: 1 },
        merge_failures_unresolved: { p: 1, a: 1, b: 0 },
        merge_failures_lever_on: { p: 2, a: 1, b: 1 },
        merge_failures_lever_off: { p: 4, a: 2, b: 2 },
      };

      // Guard: fail loudly if the catalog grows a metric with no fixture.
      const missing = METRIC_CATALOG.map((d) => d.key).filter((k) => !(k in expected));
      expect(missing).toEqual([]);

      // Compare whole scope-maps so a mismatch names the offending metric in the diff.
      const portfolioActual: Record<string, number | undefined> = {};
      const portfolioExpected: Record<string, number | undefined> = {};
      const alphaActual: Record<string, number | undefined> = {};
      const alphaExpected: Record<string, number | undefined> = {};
      const betaActual: Record<string, number | undefined> = {};
      const betaExpected: Record<string, number | undefined> = {};

      for (const def of METRIC_CATALOG) {
        const exp = expected[def.key];
        if (!exp) throw new Error(`unreachable: missing expectation for ${def.key}`);
        portfolioActual[def.key] = metric(db, METRICS_PORTFOLIO, def.key);
        portfolioExpected[def.key] = exp.p;
        if (def.scope === "both") {
          alphaActual[def.key] = metric(db, alpha, def.key);
          alphaExpected[def.key] = exp.a;
          betaActual[def.key] = metric(db, beta, def.key);
          betaExpected[def.key] = exp.b;
        } else {
          // portfolio-only metrics must write NO project row at either scope.
          alphaActual[def.key] = metric(db, alpha, def.key);
          alphaExpected[def.key] = undefined;
          betaActual[def.key] = metric(db, beta, def.key);
          betaExpected[def.key] = undefined;
        }
      }

      expect(portfolioActual).toEqual(portfolioExpected);
      expect(alphaActual).toEqual(alphaExpected);
      expect(betaActual).toEqual(betaExpected);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(alphaRepo, { recursive: true, force: true });
      rmSync(betaRepo, { recursive: true, force: true });
    }
  });
});
