import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, METRICS_PORTFOLIO, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { dayKey, floorToUtcDay, rollupDay } from "../src/metrics/rollup.ts";

const DAY_START = floorToUtcDay(Date.parse("2026-06-20T12:00:00Z")); // a fixed UTC day

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-rollup-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return { db, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedProject(
  db: ReturnType<typeof createDb>,
  slug: string,
  autonomyMode: "collaborative" | "autonomous",
): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ceremony: "personal",
      workdirPath: `/tmp/no-such-${slug}`, // not a git repo → git metrics skip
      autonomyMode,
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

function metric(
  db: ReturnType<typeof createDb>,
  projectId: string,
  key: string,
): number | undefined {
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

describe("rollupDay", () => {
  test("computes DB flow + snapshot metrics at project and portfolio scope", async () => {
    const h = setup();
    try {
      const collab = seedProject(h.db, "alpha", "collaborative");
      const auto = seedProject(h.db, "beta", "autonomous");
      const mid = DAY_START + 6 * 60 * 60_000;
      // alpha: 2 completed, 1 failed; beta: 1 completed
      seedRun(h.db, collab, "completed", mid);
      seedRun(h.db, collab, "completed", mid + 1000);
      seedRun(h.db, collab, "failed", mid + 2000);
      seedRun(h.db, auto, "completed", mid);
      // a run OUTSIDE the window must not count
      seedRun(h.db, collab, "completed", DAY_START - 5000);
      // decisions: 2 on alpha (1 auto_ratified), 1 on beta (auto_ratified)
      seedDecision(h.db, collab, "pending", mid);
      seedDecision(h.db, collab, "auto_ratified", mid);
      seedDecision(h.db, auto, "auto_ratified", mid);

      const { rows } = await rollupDay(h.db, DAY_START + 1000);
      expect(rows).toBeGreaterThan(0);

      // portfolio flow
      expect(metric(h.db, METRICS_PORTFOLIO, "runs_total")).toBe(4); // window only
      expect(metric(h.db, METRICS_PORTFOLIO, "runs_completed")).toBe(3);
      expect(metric(h.db, METRICS_PORTFOLIO, "runs_failed")).toBe(1);
      expect(metric(h.db, METRICS_PORTFOLIO, "decisions_total")).toBe(3);
      expect(metric(h.db, METRICS_PORTFOLIO, "auto_ratified_total")).toBe(2);

      // per-project flow
      expect(metric(h.db, collab, "runs_total")).toBe(3);
      expect(metric(h.db, collab, "runs_failed")).toBe(1);
      expect(metric(h.db, auto, "runs_total")).toBe(1);

      // portfolio snapshots
      expect(metric(h.db, METRICS_PORTFOLIO, "active_projects")).toBe(2);
      expect(metric(h.db, METRICS_PORTFOLIO, "projects_collaborative")).toBe(1);
      expect(metric(h.db, METRICS_PORTFOLIO, "projects_autonomous")).toBe(1);

      // git metrics skipped for non-git workdirs (null → no row)
      expect(metric(h.db, collab, "commits")).toBeUndefined();
      expect(metric(h.db, METRICS_PORTFOLIO, "loc_added")).toBeUndefined();

      // snapshots are portfolio-only — no per-project active_projects row
      expect(metric(h.db, collab, "active_projects")).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("is idempotent — re-running upserts, never duplicates", async () => {
    const h = setup();
    try {
      const p = seedProject(h.db, "alpha", "collaborative");
      seedRun(h.db, p, "completed", DAY_START + 1000);

      await rollupDay(h.db, DAY_START);
      await rollupDay(h.db, DAY_START); // again

      const all = h.db.select().from(schema.metricsDaily).all();
      const keys = all.map((r) => `${r.date}|${r.projectId}|${r.metric}`);
      expect(new Set(keys).size).toBe(keys.length); // no duplicate (date,project,metric)
      expect(metric(h.db, METRICS_PORTFOLIO, "runs_total")).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
