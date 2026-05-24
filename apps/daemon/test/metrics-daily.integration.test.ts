import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, openSqlite, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";

import type { DaemonContext } from "../src/context.ts";
import { metricsRouter } from "../src/routers/metrics.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(metricsRouter);

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}

interface Harness {
  db: ReturnType<typeof createDb>;
  dbPath: string;
  caller: ReturnType<typeof createCaller>;
  cleanup: () => void;
}

function setup(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-metrics-daily-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const ctx = {
    db,
    authorized: true,
    // Other DaemonContext fields are unused by metricsRouter.daily.
    config: null,
    events: null,
    runs: null,
    pool: null,
    scripts: null,
  } as unknown as DaemonContext;
  const caller = createCaller(ctx);
  return {
    db,
    dbPath,
    caller,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function seedProject(db: ReturnType<typeof createDb>, slug: string): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath: `/tmp/${slug}`,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
    })
    .run();
  return id;
}

interface MetricSeed {
  ownerKind: "run" | "audit" | "plan_iteration" | "triage";
  ownerId: string;
  projectId: string | null;
  model: string | null;
  createdAt: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
}

function seedMetric(db: ReturnType<typeof createDb>, m: MetricSeed) {
  db.insert(schema.claudeMetrics)
    .values({
      id: createId(),
      ownerKind: m.ownerKind,
      ownerId: m.ownerId,
      projectId: m.projectId,
      model: m.model,
      modelUsage: null,
      totalCostUsd: m.totalCostUsd ?? 0,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheCreationTokens: m.cacheCreationTokens ?? 0,
      cacheReadTokens: m.cacheReadTokens ?? 0,
      durationMs: m.durationMs ?? 0,
      durationApiMs: 0,
      numTurns: 1,
      sessionId: null,
      isError: false,
      subtype: "success",
      createdAt: m.createdAt,
    })
    .run();
}

/** UTC midnight for an ISO date string like "2026-05-20". */
function utcMidnight(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getTime();
}

describe("metrics.daily", () => {
  test("zero-fills empty days across the requested range", async () => {
    const h = setup();
    try {
      const p = seedProject(h.db, "p1");
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r1",
        projectId: p,
        model: "claude-opus-4-7",
        createdAt: utcMidnight("2026-05-21") + 60_000,
        totalCostUsd: 0.5,
        inputTokens: 1000,
        outputTokens: 200,
      });

      const res = await h.caller.daily({
        start: "2026-05-20T00:00:00.000Z",
        end: "2026-05-23T00:00:00.000Z",
        groupBy: "none",
      });

      expect(res.days).toEqual(["2026-05-20", "2026-05-21", "2026-05-22"]);
      expect(res.series.length).toBe(1);
      const buckets = defined(res.series[0]).buckets;
      expect(buckets.length).toBe(3);
      const [d20, d21, d22] = [defined(buckets[0]), defined(buckets[1]), defined(buckets[2])];
      expect(d20.totalCostUsd).toBe(0);
      expect(d20.invocations).toBe(0);
      expect(d21.totalCostUsd).toBeCloseTo(0.5);
      expect(d21.inputTokens).toBe(1000);
      expect(d21.runCount).toBe(1);
      expect(d22.totalCostUsd).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("scopes by projectId when provided", async () => {
    const h = setup();
    try {
      const a = seedProject(h.db, "a");
      const b = seedProject(h.db, "b");
      const day = utcMidnight("2026-05-21") + 60_000;
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "ra",
        projectId: a,
        model: "m1",
        createdAt: day,
        totalCostUsd: 0.3,
        inputTokens: 100,
      });
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "rb",
        projectId: b,
        model: "m1",
        createdAt: day,
        totalCostUsd: 0.7,
        inputTokens: 999,
      });

      const res = await h.caller.daily({
        start: "2026-05-20T00:00:00.000Z",
        end: "2026-05-22T00:00:00.000Z",
        projectId: a,
        groupBy: "none",
      });

      expect(res.series.length).toBe(1);
      const sums = defined(res.series[0]).buckets.reduce(
        (acc, b) => ({
          cost: acc.cost + b.totalCostUsd,
          input: acc.input + b.inputTokens,
        }),
        { cost: 0, input: 0 },
      );
      expect(sums.cost).toBeCloseTo(0.3);
      expect(sums.input).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  test("groupBy='project' partitions series and zero-fills each", async () => {
    const h = setup();
    try {
      const a = seedProject(h.db, "alpha");
      const b = seedProject(h.db, "beta");
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r1",
        projectId: a,
        model: "m",
        createdAt: utcMidnight("2026-05-20") + 1,
        totalCostUsd: 1,
      });
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r2",
        projectId: b,
        model: "m",
        createdAt: utcMidnight("2026-05-21") + 1,
        totalCostUsd: 2,
      });

      const res = await h.caller.daily({
        start: "2026-05-20T00:00:00.000Z",
        end: "2026-05-22T00:00:00.000Z",
        groupBy: "project",
      });

      expect(res.days).toEqual(["2026-05-20", "2026-05-21"]);
      expect(res.series.length).toBe(2);
      for (const s of res.series) {
        expect(s.buckets.length).toBe(2);
      }
      const byKey = new Map(res.series.map((s) => [s.key, s]));
      const seriesA = defined(byKey.get(a)).buckets;
      const seriesB = defined(byKey.get(b)).buckets;
      expect(defined(seriesA[0]).totalCostUsd).toBeCloseTo(1);
      expect(defined(seriesA[1]).totalCostUsd).toBe(0);
      expect(defined(seriesB[0]).totalCostUsd).toBe(0);
      expect(defined(seriesB[1]).totalCostUsd).toBeCloseTo(2);
    } finally {
      h.cleanup();
    }
  });

  test("groupBy='model' partitions by primary model id", async () => {
    const h = setup();
    try {
      const p = seedProject(h.db, "p");
      const day = utcMidnight("2026-05-21") + 1;
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r1",
        projectId: p,
        model: "claude-opus-4-7",
        createdAt: day,
        totalCostUsd: 1,
      });
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r2",
        projectId: p,
        model: "claude-sonnet-4-6",
        createdAt: day,
        totalCostUsd: 0.1,
      });

      const res = await h.caller.daily({
        start: "2026-05-21T00:00:00.000Z",
        end: "2026-05-22T00:00:00.000Z",
        groupBy: "model",
      });

      expect(res.series.length).toBe(2);
      const models = res.series.map((s) => s.key).sort();
      expect(models).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    } finally {
      h.cleanup();
    }
  });

  test("runCount counts distinct run owner_ids, not all invocations", async () => {
    const h = setup();
    try {
      const p = seedProject(h.db, "p");
      const day = utcMidnight("2026-05-21");
      // Two distinct runs, three claude invocations total (run r1 has two iterations).
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r1",
        projectId: p,
        model: "m",
        createdAt: day + 1_000,
        totalCostUsd: 0.1,
      });
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r1",
        projectId: p,
        model: "m",
        createdAt: day + 2_000,
        totalCostUsd: 0.1,
      });
      seedMetric(h.db, {
        ownerKind: "run",
        ownerId: "r2",
        projectId: p,
        model: "m",
        createdAt: day + 3_000,
        totalCostUsd: 0.1,
      });
      // A non-run owner kind should not contribute to runCount.
      seedMetric(h.db, {
        ownerKind: "plan_iteration",
        ownerId: "plan-x",
        projectId: p,
        model: "m",
        createdAt: day + 4_000,
        totalCostUsd: 0.1,
      });

      const res = await h.caller.daily({
        start: "2026-05-21T00:00:00.000Z",
        end: "2026-05-22T00:00:00.000Z",
        groupBy: "none",
      });

      const bucket = defined(defined(res.series[0]).buckets[0]);
      expect(bucket.runCount).toBe(2);
      expect(bucket.invocations).toBe(4);
      expect(bucket.totalCostUsd).toBeCloseTo(0.4);
    } finally {
      h.cleanup();
    }
  });

  test("rejects invalid time ranges", async () => {
    const h = setup();
    try {
      await expect(
        h.caller.daily({
          start: "2026-05-22T00:00:00.000Z",
          end: "2026-05-21T00:00:00.000Z",
          groupBy: "none",
        }),
      ).rejects.toThrow(/end must be after start/);
    } finally {
      h.cleanup();
    }
  });

  test("EXPLAIN QUERY PLAN uses claude_metrics indexes on createdAt and (projectId, createdAt)", () => {
    const h = setup();
    try {
      // Use a raw bun:sqlite handle on the same db file so we can run
      // EXPLAIN QUERY PLAN directly against the same statements drizzle
      // emits. Seed enough rows that the planner doesn't prefer a scan.
      const sqlite = openSqlite(h.dbPath);
      const project = "p1";
      h.db
        .insert(schema.projects)
        .values({
          id: project,
          slug: "p1",
          name: "p1",
          ideaId: null,
          role: "owner",
          ceremony: "tinker",
          tag: "active",
          workdirPath: "/tmp/p1",
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          autoAdvance: true,
          model: null,
        })
        .run();

      const N = 10_000;
      const insert = sqlite.prepare(
        "INSERT INTO claude_metrics (id, owner_kind, owner_id, project_id, model, total_cost_usd, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, duration_ms, duration_api_ms, num_turns, is_error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      sqlite.exec("BEGIN");
      const baseTs = Date.UTC(2026, 0, 1);
      for (let i = 0; i < N; i++) {
        insert.run(
          `m${i}`,
          "run",
          `r${i % 100}`,
          project,
          "m1",
          0.01,
          10,
          5,
          0,
          0,
          50,
          50,
          1,
          0,
          baseTs + i * 1000,
        );
      }
      sqlite.exec("COMMIT");
      sqlite.exec("ANALYZE");

      // Without projectId — should hit claude_metrics_created_idx.
      const planA = sqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, SUM(total_cost_usd) FROM claude_metrics WHERE created_at >= ? AND created_at < ? GROUP BY day",
        )
        .all(baseTs, baseTs + N * 1000) as Array<{ detail: string }>;
      const planAText = planA.map((r) => r.detail).join(" | ");
      expect(planAText).toContain("claude_metrics_created_idx");

      // With projectId — should hit the composite index.
      const planB = sqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, SUM(total_cost_usd) FROM claude_metrics WHERE project_id = ? AND created_at >= ? AND created_at < ? GROUP BY day",
        )
        .all(project, baseTs, baseTs + N * 1000) as Array<{ detail: string }>;
      const planBText = planB.map((r) => r.detail).join(" | ");
      expect(planBText).toContain("claude_metrics_project_created_idx");

      sqlite.close();
    } finally {
      h.cleanup();
    }
  }, 30_000);
});
