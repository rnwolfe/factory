import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { recordAutonomyEvent } from "../src/autonomy/events.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "autonomy-events-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  return { db, events, published, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(db: ReturnType<typeof createDb>, autonomyConfig: object | null): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: `s-${id.slice(0, 6)}`,
      name: "Demo",
      ceremony: "personal",
      workdirPath: `/tmp/${id}`,
      createdAt: now,
      lastActivityAt: now,
      autonomyConfig: autonomyConfig ? JSON.stringify(autonomyConfig) : null,
    })
    .run();
  return id;
}

function autonomyEvents(published: DaemonEvent[]) {
  return published.filter((e) => e.channel === "events" && e.kind === "autonomy_event");
}

describe("recordAutonomyEvent", () => {
  test("persists the event and emits it with the resolved alert route", () => {
    const h = setup();
    try {
      const p = addProject(h.db, null);
      recordAutonomyEvent(h.db, h.events, {
        kind: "trust_contracted",
        projectId: p,
        message: "Demo paused",
      });

      // persisted
      const rows = h.db.select().from(schema.autonomyEvents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("trust_contracted");
      expect(rows[0]?.projectId).toBe(p);

      // emitted with the default `push` route (loud-on-risk)
      const ev = autonomyEvents(h.published);
      expect(ev).toHaveLength(1);
      // biome-ignore lint/suspicious/noExplicitAny: narrowing the union for the test
      expect((ev[0] as any).alert).toBe("push");
      // biome-ignore lint/suspicious/noExplicitAny: narrowing the union for the test
      expect((ev[0] as any).autonomyKind).toBe("trust_contracted");
    } finally {
      h.cleanup();
    }
  });

  test("a digest-default kind routes to digest, not push", () => {
    const h = setup();
    try {
      const p = addProject(h.db, null);
      recordAutonomyEvent(h.db, h.events, { kind: "gate_passed", projectId: p, message: "ok" });
      // biome-ignore lint/suspicious/noExplicitAny: union narrowing
      expect((autonomyEvents(h.published)[0] as any).alert).toBe("digest");
    } finally {
      h.cleanup();
    }
  });

  test("a per-project alert override changes the route", () => {
    const h = setup();
    try {
      // turn the (normally push) contraction alert off for this project
      const p = addProject(h.db, { alerts: { trust_contracted: "off" } });
      recordAutonomyEvent(h.db, h.events, {
        kind: "trust_contracted",
        projectId: p,
        message: "Demo paused",
      });
      // biome-ignore lint/suspicious/noExplicitAny: union narrowing
      expect((autonomyEvents(h.published)[0] as any).alert).toBe("off");
    } finally {
      h.cleanup();
    }
  });
});
