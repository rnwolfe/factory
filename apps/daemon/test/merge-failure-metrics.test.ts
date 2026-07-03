import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { EventBus } from "../src/events.ts";
import { computeMetricDayBucket } from "../src/metrics/snapshot.ts";
import { MERGE_FAILURE_OUTCOME, recordMergeFailure } from "../src/workers/merge-failure.ts";

/**
 * Feature plan mnx1zt27, acceptance #3 — a lever-auto resolve and a lever-manual
 * operator-approved resolution each increment their respective DISTINCT ops-metric
 * counters exactly once. Drives the real `recordMergeFailure` (which captures the
 * merge-remediation lever value at the time) and the real catalog compute
 * (`computeMetricDayBucket`), so the classifier + lever capture are exercised
 * end to end — not re-implemented in the test.
 */

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "merge-failure-metrics-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    events: new EventBus(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedProject(db: ReturnType<typeof createDb>, autonomyConfig: string): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: "alpha",
      name: "alpha",
      ceremony: "personal",
      workdirPath: "/tmp/no-such-alpha",
      autonomyMode: "autonomous",
      autonomyConfig,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

describe("merge-failure ops metrics (feature plan mnx1zt27)", () => {
  test("a lever-auto resolve and an operator-approved resolve each bump their own counter exactly once", async () => {
    const h = setup();
    try {
      // Lever `dirtyAutoReset` ON so the auto path captures leverOn=true; conflict
      // resolution stays operator-gated (conflictAutoResolve off by default).
      const project = seedProject(
        h.db,
        JSON.stringify({ mergeRemediation: { dirtyAutoReset: true } }),
      );

      // ── Path A: lever-auto resolve. The runner reset a dirty `main` and merged
      //    unattended, recording an already-actioned audit decision.
      const autoId = await recordMergeFailure(h.db, h.events, {
        projectId: project,
        reason: "dirty",
        message: "main was dirty",
        resolvedOutcome: MERGE_FAILURE_OUTCOME.autoDirtyReset,
        payload: { runId: createId(), branch: "factory/run-a" },
      });

      // ── Path B: lever-manual operator-approved resolve. A conflict surfaced as
      //    a pending decision (lever off), then the operator tapped "apply
      //    resolution" → actioned with the operator-resolve outcome.
      const opId = await recordMergeFailure(h.db, h.events, {
        projectId: project,
        reason: "conflict",
        message: "merge conflicted",
        payload: { runId: createId(), branch: "factory/run-b" },
      });
      h.db
        .update(schema.decisions)
        .set({
          status: "actioned",
          actionedAt: Date.now(),
          outcome: MERGE_FAILURE_OUTCOME.operatorConflictResolve,
        })
        .where(eq(schema.decisions.id, opId))
        .run();

      // Lever capture is honest: the auto (dirty) row recorded the ON lever, the
      // operator (conflict) row recorded the OFF lever governing its reason.
      const autoRow = h.db
        .select({ payload: schema.decisions.payload })
        .from(schema.decisions)
        .where(eq(schema.decisions.id, autoId))
        .get();
      expect(
        (autoRow?.payload as { levers?: { dirtyAutoReset?: boolean } }).levers?.dirtyAutoReset,
      ).toBe(true);

      const now = Date.now();
      const bucket = (metric: string) => computeMetricDayBucket(h.db, metric, project, now);

      // Each resolution increments ONLY its own counter — exactly once.
      expect(await bucket("merge_failures_resolved_auto_dirty_reset")).toBe(1);
      expect(await bucket("merge_failures_resolved_operator_agent_resolve")).toBe(1);
      // …and not each other's, nor the other paths.
      expect(await bucket("merge_failures_resolved_auto_agent_resolve")).toBe(0);
      expect(await bucket("merge_failures_resolved_manual_tmux")).toBe(0);
      expect(await bucket("merge_failures_unresolved")).toBe(0);

      // Lever breakdown: auto(dirty, lever on) = 1; operator(conflict, lever off) = 1.
      expect(await bucket("merge_failures_lever_on")).toBe(1);
      expect(await bucket("merge_failures_lever_off")).toBe(1);

      // Reason + total invariants.
      expect(await bucket("merge_failures_dirty")).toBe(1);
      expect(await bucket("merge_failures_conflict")).toBe(1);
      expect(await bucket("merge_failures_total")).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});
