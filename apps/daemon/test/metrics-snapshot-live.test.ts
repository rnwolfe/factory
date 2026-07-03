import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, METRICS_PORTFOLIO, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { DaemonContext } from "../src/context.ts";
import { floorToUtcDay } from "../src/metrics/rollup.ts";
import { computeLiveSnapshot } from "../src/metrics/snapshot.ts";
import { metricsRouter } from "../src/routers/metrics.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(metricsRouter);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-snap-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const caller = createCaller({ db, authorized: true } as unknown as DaemonContext);
  return { db, caller, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedProject(db: ReturnType<typeof createDb>, slug: string): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ceremony: "personal",
      workdirPath: `/tmp/no-such-${slug}`, // not a git repo → git metrics skip
      autonomyMode: "collaborative",
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

function seedRun(
  db: ReturnType<typeof createDb>,
  projectId: string,
  status: "completed" | "failed",
  startedAt: number,
): void {
  db.insert(schema.runs)
    .values({
      id: createId(),
      projectId,
      status,
      branch: "factory/run-x",
      worktreePath: "/tmp/wt",
      startedAt,
      endedAt: startedAt + 1000,
      budgetSeconds: 60,
    })
    .run();
}

function seedDecision(
  db: ReturnType<typeof createDb>,
  projectId: string,
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

describe("computeLiveSnapshot (live-from-source)", () => {
  test("survives just-after-UTC-midnight: empty today bucket, activity in source tables", async () => {
    const h = setup();
    try {
      // A moment 30s past a fresh UTC midnight — the rollup tick has NOT run for
      // this new day yet, so metrics_daily's "today" is empty/near-empty.
      const midnight = floorToUtcDay(Date.parse("2026-06-21T12:00:00Z")) + 86_400_000;
      const now = midnight + 30_000;

      const p = seedProject(h.db, "alpha");
      // Live activity that landed in the first 30s of the new day.
      seedRun(h.db, p, "completed", midnight + 5_000);
      seedRun(h.db, p, "completed", midnight + 10_000);
      seedRun(h.db, p, "failed", midnight + 15_000);
      seedDecision(h.db, p, "auto_ratified", midnight + 6_000);
      seedDecision(h.db, p, "pending", midnight + 7_000);

      // Simulate the stale rollup: yesterday is fully rolled up, today is empty.
      // A stale/empty today bucket must NOT be what the snapshot returns.
      const yesterday = new Date(midnight - 86_400_000).toISOString().slice(0, 10);
      const today = new Date(midnight).toISOString().slice(0, 10);
      h.db
        .insert(schema.metricsDaily)
        .values({
          date: yesterday,
          projectId: METRICS_PORTFOLIO,
          metric: "runs_total",
          value: 99,
          updatedAt: 1,
        })
        .run();
      h.db
        .insert(schema.metricsDaily)
        .values({
          date: today,
          projectId: METRICS_PORTFOLIO,
          metric: "runs_total",
          value: 0,
          updatedAt: 1,
        })
        .run();

      const snap = await computeLiveSnapshot(h.db, METRICS_PORTFOLIO, now);

      // Live source values — not the stale 0 in metrics_daily, not yesterday's 99.
      expect(snap.date).toBe(today);
      expect(snap.metrics.runs_total).toBe(3);
      expect(snap.metrics.runs_completed).toBe(2);
      expect(snap.metrics.runs_failed).toBe(1);
      expect(snap.metrics.decisions_total).toBe(2);
      expect(snap.metrics.auto_ratified_total).toBe(1);
      // Derived ratios computed from the live counts, not a rolled-up bucket.
      expect(snap.derived.decisions_per_run).toBeCloseTo(2 / 3);
      expect(snap.derived.auto_ratify_rate).toBeCloseTo(1 / 2);
    } finally {
      h.cleanup();
    }
  });

  test("window ends at request time — activity later today is excluded", async () => {
    const h = setup();
    try {
      const midnight = floorToUtcDay(Date.parse("2026-06-21T00:00:00Z"));
      const now = midnight + 6 * 60 * 60_000; // 06:00 UTC

      const p = seedProject(h.db, "alpha");
      seedRun(h.db, p, "completed", midnight + 1000); // before now → counts
      seedRun(h.db, p, "completed", now + 60_000); // after now → excluded
      seedRun(h.db, p, "completed", midnight - 1000); // yesterday → excluded

      const snap = await computeLiveSnapshot(h.db, METRICS_PORTFOLIO, now);
      expect(snap.metrics.runs_total).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("per-project scope isolates to that project", async () => {
    const h = setup();
    try {
      const midnight = floorToUtcDay(Date.parse("2026-06-21T00:00:00Z"));
      const now = midnight + 3 * 60 * 60_000;
      const a = seedProject(h.db, "alpha");
      const b = seedProject(h.db, "beta");
      seedRun(h.db, a, "completed", midnight + 1000);
      seedRun(h.db, a, "completed", midnight + 2000);
      seedRun(h.db, b, "completed", midnight + 1000);

      const snapA = await computeLiveSnapshot(h.db, a, now);
      expect(snapA.metrics.runs_total).toBe(2);
      const snapPortfolio = await computeLiveSnapshot(h.db, METRICS_PORTFOLIO, now);
      expect(snapPortfolio.metrics.runs_total).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  test("recording a new run/decision changes the next snapshot — no rollup tick required", async () => {
    const h = setup();
    try {
      const p = seedProject(h.db, "alpha");
      // Anchor timestamps to the real current UTC day so the router's internal
      // Date.now() window includes them.
      const now = Date.now();
      const dayStart = floorToUtcDay(now);
      const at = Math.max(dayStart + 1000, now - 1000); // safely inside [dayStart, now)

      const before = await h.caller.snapshot(); // portfolio
      const runsBefore = before.metrics.runs_total ?? 0;
      const decisionsBefore = before.metrics.decisions_total ?? 0;

      seedRun(h.db, p, "completed", at);
      seedDecision(h.db, p, "auto_ratified", at);

      // No rollupDay() call in between — snapshot must reflect the new rows.
      const after = await h.caller.snapshot();
      expect(after.metrics.runs_total ?? 0).toBe(runsBefore + 1);
      expect(after.metrics.decisions_total ?? 0).toBe(decisionsBefore + 1);

      // And metrics_daily was never written by the snapshot path.
      const rolled = h.db.select().from(schema.metricsDaily).all();
      expect(rolled.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
