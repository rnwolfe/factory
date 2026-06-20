import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { EventBus } from "../src/events.ts";
import { maybeEmitQueueEmptyNudge, resolveQueueEmptyNudges } from "../src/inbox/queue-empty.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-queue-empty-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const now = Date.now();
  const project = { id: createId(), slug: "demo", name: "Demo" };
  db.insert(schema.projects)
    .values({
      id: project.id,
      slug: project.slug,
      name: project.name,
      ceremony: "personal",
      role: "owner",
      tag: "active",
      workdirPath: path.join(root, "demo"),
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  const setFlag = (on: boolean) => {
    const value = on ? "true" : "false";
    db.insert(schema.settings)
      .values({ key: "notify-on-queue-empty", value, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value, updatedAt: Date.now() },
      })
      .run();
  };
  const pendingCount = () =>
    db
      .select({ id: schema.decisions.id })
      .from(schema.decisions)
      .where(
        and(
          eq(schema.decisions.kind, "queue_empty"),
          eq(schema.decisions.projectId, project.id),
          eq(schema.decisions.status, "pending"),
        ),
      )
      .all().length;
  return {
    db,
    events,
    project,
    setFlag,
    pendingCount,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("queue-empty nudge (task-050)", () => {
  test("flag OFF (default) → no nudge emitted", async () => {
    const h = setup();
    try {
      await maybeEmitQueueEmptyNudge(h.db, h.events, h.project);
      expect(h.pendingCount()).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("flag ON → single nudge, and re-firing is de-duped", async () => {
    const h = setup();
    try {
      h.setFlag(true);
      await maybeEmitQueueEmptyNudge(h.db, h.events, h.project);
      await maybeEmitQueueEmptyNudge(h.db, h.events, h.project);
      expect(h.pendingCount()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("resolveQueueEmptyNudges clears the open nudge", async () => {
    const h = setup();
    try {
      h.setFlag(true);
      await maybeEmitQueueEmptyNudge(h.db, h.events, h.project);
      expect(h.pendingCount()).toBe(1);
      await resolveQueueEmptyNudges(h.db, h.events, h.project.id);
      expect(h.pendingCount()).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
