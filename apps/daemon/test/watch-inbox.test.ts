import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { surfaceObservations, type WatchInsightPayload } from "../src/watch/observation-inbox.ts";
import type { PersistedObservation } from "../src/watch/observation-store.ts";

function obs(over: Partial<PersistedObservation> = {}): PersistedObservation {
  return {
    id: createId(),
    kind: "repeated-ritual",
    title: "Builds CLIs by hand",
    detail: "Across 3 sessions the same scaffold steps recur.",
    evidence: [{ sourceId: "claude-code", sessionId: "abc12345" }],
    proposal: "note-only",
    targetProjectSlug: null,
    ...over,
  };
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "watch-inbox-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  return {
    db,
    events,
    published,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Seed the observation row that surfacing flips to `surfaced`. */
function seedObservation(db: ReturnType<typeof createDb>, o: PersistedObservation, key: string) {
  const now = Date.now();
  db.insert(schema.watchObservations)
    .values({
      id: o.id,
      kind: o.kind,
      title: o.title,
      detail: o.detail,
      evidence: JSON.stringify(o.evidence),
      proposal: o.proposal,
      targetProjectSlug: o.targetProjectSlug,
      status: "pending",
      dedupeKey: key,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("surfaceObservations", () => {
  test("creates a watch_insight decision, resolves the project, flips status", () => {
    const h = setup();
    try {
      const now = Date.now();
      const projectId = createId();
      h.db
        .insert(schema.projects)
        .values({
          id: projectId,
          slug: "acme",
          name: "Acme",
          ceremony: "personal",
          workdirPath: path.join(h.root, "acme"),
          createdAt: now,
          lastActivityAt: now,
        })
        .run();
      const o = obs({ targetProjectSlug: "acme", proposal: "adopt-as-task" });
      seedObservation(h.db, o, "k1");

      surfaceObservations(h.db, h.events, [o]);

      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.kind, "watch_insight"))
        .get();
      expect(decision?.projectId).toBe(projectId);
      const payload = decision?.payload as WatchInsightPayload;
      expect(payload.observationId).toBe(o.id);
      expect(payload.proposal).toBe("adopt-as-task");
      expect(payload.evidence).toEqual(o.evidence);

      const row = h.db
        .select()
        .from(schema.watchObservations)
        .where(eq(schema.watchObservations.id, o.id))
        .get();
      expect(row?.status).toBe("surfaced");

      expect(h.published.some((e) => "kind" in e && e.kind === "decision_created")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("an operator-level insight (no slug) gets a null-project decision", () => {
    const h = setup();
    try {
      const o = obs({ targetProjectSlug: null });
      seedObservation(h.db, o, "k2");

      surfaceObservations(h.db, h.events, [o]);

      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.kind, "watch_insight"))
        .get();
      expect(decision?.projectId).toBeNull();
      expect((decision?.payload as WatchInsightPayload).targetProjectSlug).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
