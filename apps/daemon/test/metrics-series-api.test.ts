import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, METRICS_PORTFOLIO, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { DaemonContext } from "../src/context.ts";
import { metricsRouter } from "../src/routers/metrics.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(metricsRouter);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-api-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const caller = createCaller({ db, authorized: true } as unknown as DaemonContext);
  return { db, caller, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function put(
  db: ReturnType<typeof createDb>,
  date: string,
  projectId: string,
  metric: string,
  value: number,
) {
  db.insert(schema.metricsDaily).values({ date, projectId, metric, value, updatedAt: 1 }).run();
}

describe("metricsRouter time-series API", () => {
  test("catalog exposes the metric keys + scopes", async () => {
    const h = setup();
    try {
      const catalog = await h.caller.catalog();
      const keys = catalog.map((c) => c.key);
      expect(keys).toContain("runs_total");
      expect(keys).toContain("loc_added");
      expect(catalog.find((c) => c.key === "active_projects")?.scope).toBe("portfolio");
      // Every entry declares an explicit snapshot window (no implicit tile window).
      expect(catalog.every((c) => typeof c.window === "string")).toBe(true);
      expect(catalog.find((c) => c.key === "runs_total")?.window).toBe("cumulative");
      expect(catalog.find((c) => c.key === "active_projects")?.window).toBe("rolling_7d");
    } finally {
      h.cleanup();
    }
  });

  test("series returns an ordered portfolio time-series, with date bounds", async () => {
    const h = setup();
    try {
      put(h.db, "2026-06-20", METRICS_PORTFOLIO, "runs_total", 4);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "runs_total", 6);
      put(h.db, "2026-06-22", METRICS_PORTFOLIO, "runs_total", 2);
      put(h.db, "2026-06-21", "p1", "runs_total", 5); // different scope, must not leak

      // Bound `to` before the current UTC day so this asserts pure finalized-day
      // behavior; the live current-day point is exercised in its own test below.
      const all = await h.caller.series({ metric: "runs_total", to: "2026-06-30" });
      expect(all).toEqual([
        { date: "2026-06-20", value: 4 },
        { date: "2026-06-21", value: 6 },
        { date: "2026-06-22", value: 2 },
      ]);

      const windowed = await h.caller.series({
        metric: "runs_total",
        from: "2026-06-21",
        to: "2026-06-21",
      });
      expect(windowed).toEqual([{ date: "2026-06-21", value: 6 }]);

      const p1 = await h.caller.series({ metric: "runs_total", projectId: "p1" });
      expect(p1).toEqual([{ date: "2026-06-21", value: 5 }]);
    } finally {
      h.cleanup();
    }
  });

  test("snapshot reads live from source, ignoring the metrics_daily rollup", async () => {
    const h = setup();
    try {
      // Rolled-up buckets in metrics_daily must NOT drive the snapshot anymore.
      // Seed some (they carry different values than the live source tables) and
      // assert the snapshot ignores them entirely — see metrics-snapshot-live
      // for the full just-after-midnight regression.
      put(h.db, "2026-06-20", METRICS_PORTFOLIO, "runs_total", 4);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "runs_total", 6);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "decisions_total", 3);

      // Live source activity in the current UTC day.
      const now = Date.now();
      const at = Math.max(Math.floor(now / 86_400_000) * 86_400_000 + 1000, now - 1000);
      const p = createId();
      h.db
        .insert(schema.projects)
        .values({
          id: p,
          slug: "alpha",
          name: "alpha",
          ceremony: "personal",
          workdirPath: "/tmp/no-such-alpha",
          autonomyMode: "collaborative",
          createdAt: now,
          lastActivityAt: now,
        })
        .run();
      h.db
        .insert(schema.runs)
        .values({
          id: createId(),
          projectId: p,
          status: "completed",
          branch: "factory/run-x",
          worktreePath: "/tmp/wt",
          startedAt: at,
          endedAt: at + 1000,
          budgetSeconds: 60,
        })
        .run();
      h.db
        .insert(schema.decisions)
        .values({
          id: createId(),
          kind: "agent_decision",
          projectId: p,
          outcome: "decided: x",
          payload: { id: "d", decided: "x" },
          status: "auto_ratified",
          createdAt: at,
        })
        .run();

      const snap = await h.caller.snapshot();
      expect(snap.metrics.runs_total).toBe(1); // live, not the 6 in metrics_daily
      expect(snap.metrics.decisions_total).toBe(1); // live, not the 3 in metrics_daily
      expect(snap.derived.decisions_per_run).toBeCloseTo(1 / 1);
      expect(snap.derived.auto_ratify_rate).toBeCloseTo(1 / 1);
    } finally {
      h.cleanup();
    }
  });

  test("series appends a live current-day point equal to the snapshot value", async () => {
    const h = setup();
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const at = Math.max(Math.floor(now / 86_400_000) * 86_400_000 + 1000, now - 1000);

      // A finalized past day already in the rollup — must survive unchanged.
      put(h.db, "2026-06-20", METRICS_PORTFOLIO, "runs_total", 4);

      // Live source activity landing in the current UTC day.
      const p = createId();
      h.db
        .insert(schema.projects)
        .values({
          id: p,
          slug: "beta",
          name: "beta",
          ceremony: "personal",
          workdirPath: "/tmp/no-such-beta",
          autonomyMode: "collaborative",
          createdAt: now,
          lastActivityAt: now,
        })
        .run();
      for (let i = 0; i < 3; i++) {
        h.db
          .insert(schema.runs)
          .values({
            id: createId(),
            projectId: p,
            status: "completed",
            branch: `factory/run-${i}`,
            worktreePath: "/tmp/wt",
            startedAt: at,
            endedAt: at + 1000,
            budgetSeconds: 60,
          })
          .run();
      }

      const series = await h.caller.series({ metric: "runs_total" });
      const snap = await h.caller.snapshot();

      // Finalized day is verbatim; the trailing point is today, computed live.
      expect(series[0]).toEqual({ date: "2026-06-20", value: 4 });
      const last = series.at(-1);
      expect(last).toBeDefined();
      expect(last?.date).toBe(today);
      // The trailing point is today's DAY BUCKET (the 3 runs that landed today) —
      // distinct from the snapshot tile, which is now the CUMULATIVE all-time
      // count. Here they coincide (all activity is same-day + no prior runs).
      expect(last?.value).toBe(3);
      expect(snap.metrics.runs_total).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  test("no UTC-boundary zero-dip: live today supersedes a stale/empty today bucket", async () => {
    const h = setup();
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const at = Math.max(Math.floor(now / 86_400_000) * 86_400_000 + 1000, now - 1000);

      // Simulate just-after-UTC-midnight: the rollup wrote a near-empty today
      // bucket (0) before the day's runs landed. Source tables have since gained
      // activity that the day bucket doesn't yet reflect.
      put(h.db, today, METRICS_PORTFOLIO, "runs_total", 0);

      const p = createId();
      h.db
        .insert(schema.projects)
        .values({
          id: p,
          slug: "gamma",
          name: "gamma",
          ceremony: "personal",
          workdirPath: "/tmp/no-such-gamma",
          autonomyMode: "collaborative",
          createdAt: now,
          lastActivityAt: now,
        })
        .run();
      h.db
        .insert(schema.runs)
        .values({
          id: createId(),
          projectId: p,
          status: "completed",
          branch: "factory/run-z",
          worktreePath: "/tmp/wt",
          startedAt: at,
          endedAt: at + 1000,
          budgetSeconds: 60,
        })
        .run();

      const series = await h.caller.series({ metric: "runs_total" });
      const todayPoint = series.find((pt) => pt.date === today);
      // The series must NOT surface the stale 0 bucket — it reflects live source.
      expect(todayPoint).toBeDefined();
      expect(todayPoint?.value).toBe(1);
      // And there is exactly one point for today (the stale DB row didn't leak).
      expect(series.filter((pt) => pt.date === today)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
