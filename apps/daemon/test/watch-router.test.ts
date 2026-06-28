import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { DaemonContext } from "../src/context.ts";
import { watchRouter } from "../src/routers/watch.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(watchRouter);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "watch-router-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const caller = createCaller({ db, authorized: true } as unknown as DaemonContext);
  return { db, caller, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedObs(
  db: ReturnType<typeof createDb>,
  status: "pending" | "surfaced" | "adopted" | "dismissed",
  createdAt: number,
) {
  db.insert(schema.watchObservations)
    .values({
      id: createId(),
      kind: "repeated-ritual",
      title: "t",
      detail: "d",
      evidence: "[]",
      proposal: "note-only",
      targetProjectSlug: null,
      status,
      dedupeKey: createId(),
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

describe("watch.status", () => {
  test("reports cadence, per-source cursors, the observation funnel, and recent output", async () => {
    const h = setup();
    try {
      // a scan cursor for claude-code
      h.db
        .insert(schema.watchCursors)
        .values({ sourceId: "claude-code", position: "2026-06-20T00:00:00.000Z", updatedAt: 1700 })
        .run();
      // funnel: 2 surfaced, 1 adopted, 1 pending
      seedObs(h.db, "surfaced", 100);
      seedObs(h.db, "surfaced", 200);
      seedObs(h.db, "adopted", 300);
      seedObs(h.db, "pending", 400);

      const s = await h.caller.status();

      expect(s.cadence).toBe("daily"); // default
      expect(s.observations).toMatchObject({ total: 4, surfaced: 2, adopted: 1, pending: 1 });
      expect(s.recent).toHaveLength(4);
      expect(s.recent[0]?.createdAt).toBe(400); // newest first

      // sources come from the registry (claude-code + codex); the seeded cursor surfaces.
      const ids = s.sources.map((x) => x.id).sort();
      expect(ids).toEqual(["claude-code", "codex"]);
      const cc = s.sources.find((x) => x.id === "claude-code");
      expect(cc?.position).toBe("2026-06-20T00:00:00.000Z");
      expect(cc?.lastScanAt).toBe(1700);
      expect(s.lastScanAt).toBe(1700);

      // codex has no cursor seeded → null position
      expect(s.sources.find((x) => x.id === "codex")?.position).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
