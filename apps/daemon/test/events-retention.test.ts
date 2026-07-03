import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { sweepExpiredEvents } from "../src/workers/events-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-events-retention-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return { db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("events retention sweep", () => {
  test("deletes events for terminal old runs, keeps terminal-recent and non-terminal", async () => {
    const h = setup();
    try {
      const now = Date.now();
      const projectId = createId();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "retention-test",
        name: "Retention Test",
        ceremony: "personal",
        workdirPath: path.join("/tmp", "retention-test"),
        createdAt: now,
        lastActivityAt: now,
      });

      const old = now - 40 * DAY_MS; // beyond the 30d window
      const recent = now - 1 * DAY_MS; // inside the window

      // (status, endedAt, expect-events-deleted)
      const runs = [
        { key: "completed-old", status: "completed" as const, endedAt: old, deleted: true },
        { key: "failed-old", status: "failed" as const, endedAt: old, deleted: true },
        { key: "aborted-old", status: "aborted" as const, endedAt: old, deleted: true },
        { key: "completed-recent", status: "completed" as const, endedAt: recent, deleted: false },
        // non-terminal + old → never swept
        { key: "running-old", status: "running" as const, endedAt: old, deleted: false },
        { key: "queued-old", status: "queued" as const, endedAt: old, deleted: false },
        { key: "blocked-old", status: "blocked" as const, endedAt: old, deleted: false },
        // terminal but endedAt null → never swept (guards the epoch-0 fallback)
        {
          key: "completed-null-ended",
          status: "completed" as const,
          endedAt: null,
          deleted: false,
        },
      ];

      const runIds = new Map<string, string>();
      for (const r of runs) {
        const id = createId();
        runIds.set(r.key, id);
        await h.db.insert(schema.runs).values({
          id,
          projectId,
          status: r.status,
          branch: `factory/run-${id}`,
          worktreePath: `/tmp/wt/${id}`,
          startedAt: r.endedAt ?? now,
          endedAt: r.endedAt,
          budgetSeconds: 60,
        });
        // Two events per run so we can assert whole-run deletion, not row 1.
        await h.db.insert(schema.events).values([
          { runId: id, iteration: 0, ts: r.endedAt ?? now, kind: "agent_start", payload: {} },
          { runId: id, iteration: 0, ts: r.endedAt ?? now, kind: "agent_exit", payload: {} },
        ]);
      }

      const deleted = sweepExpiredEvents(h.db, { retentionDays: 30, now: () => now });

      // 3 terminal-old runs × 2 events = 6 deleted.
      expect(deleted).toBe(6);

      for (const r of runs) {
        const remaining = await h.db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.runId, runIds.get(r.key) as string))
          .all();
        expect({ key: r.key, count: remaining.length }).toEqual({
          key: r.key,
          count: r.deleted ? 0 : 2,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  test("retentionDays <= 0 disables the sweep", async () => {
    const h = setup();
    try {
      const now = Date.now();
      const projectId = createId();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "retention-off",
        name: "Retention Off",
        ceremony: "personal",
        workdirPath: "/tmp/retention-off",
        createdAt: now,
        lastActivityAt: now,
      });
      const runId = createId();
      await h.db.insert(schema.runs).values({
        id: runId,
        projectId,
        status: "completed",
        branch: `factory/run-${runId}`,
        worktreePath: `/tmp/wt/${runId}`,
        startedAt: now - 400 * DAY_MS,
        endedAt: now - 400 * DAY_MS,
        budgetSeconds: 60,
      });
      await h.db
        .insert(schema.events)
        .values({ runId, iteration: 0, ts: now, kind: "agent_exit", payload: {} });

      expect(sweepExpiredEvents(h.db, { retentionDays: 0, now: () => now })).toBe(0);
      const remaining = await h.db.select({ id: schema.events.id }).from(schema.events).all();
      expect(remaining.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
