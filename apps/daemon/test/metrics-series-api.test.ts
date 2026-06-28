import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, METRICS_PORTFOLIO, runMigrations, schema } from "@factory/db";
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

      const all = await h.caller.series({ metric: "runs_total" }); // portfolio default
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

  test("snapshot returns the latest day + derived north-star ratios", async () => {
    const h = setup();
    try {
      put(h.db, "2026-06-20", METRICS_PORTFOLIO, "runs_total", 4);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "runs_total", 6);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "decisions_total", 3);
      put(h.db, "2026-06-21", METRICS_PORTFOLIO, "auto_ratified_total", 2);

      const snap = await h.caller.snapshot();
      expect(snap.date).toBe("2026-06-21"); // latest
      expect(snap.metrics.runs_total).toBe(6);
      expect(snap.derived.decisions_per_run).toBeCloseTo(3 / 6); // north-star
      expect(snap.derived.auto_ratify_rate).toBeCloseTo(2 / 3);
    } finally {
      h.cleanup();
    }
  });
});
