import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { autoExecuteEligibleProposals } from "../src/autonomy/auto-run-groom.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { createTask, readTaskFile } from "../src/projects/tasks.ts";
import { persistObservations } from "../src/watch/observation-store.ts";
import type { RawObservation } from "../src/watch/synthesize.ts";

function setup(autonomyConfig?: object) {
  const root = mkdtempSync(path.join(tmpdir(), "auto-groom-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  const workdirPath = path.join(root, "projects", "alpha");
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  const projectId = createId();
  db.insert(schema.projects)
    .values({
      id: projectId,
      slug: "alpha",
      name: "Project alpha",
      ceremony: "personal",
      workdirPath,
      createdAt: 1,
      lastActivityAt: 1,
      autonomyMode: "autonomous",
      autonomyConfig: autonomyConfig ? JSON.stringify(autonomyConfig) : null,
    })
    .run();
  return {
    db,
    events,
    published,
    projectId,
    workdirPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Persist a groom-backlog observation (so the row exists for status updates). */
function seedGroom(db: ReturnType<typeof createDb>, taskId: string, title: string) {
  const raw: RawObservation = {
    kind: "drift",
    title,
    detail: "idle >30d",
    proposal: "groom-backlog",
    targetProjectSlug: "alpha",
    targetTaskId: taskId,
    evidence: [],
  } as unknown as RawObservation;
  return persistObservations(db, [raw]).inserted[0];
}

const ENABLED = { autorun: { enabled: true, classes: ["groom-backlog"] } };

function autoRanEvents(published: DaemonEvent[]) {
  return published.filter(
    (e) => e.channel === "events" && e.kind === "autonomy_event" && e.autonomyKind === "auto_ran",
  );
}

describe("autoExecuteEligibleProposals (Phase C — groom-backlog)", () => {
  test("DARK by default: autonomous project, default config → nothing executes, task untouched", async () => {
    const h = setup(); // no autonomyConfig → autorun disabled, classes empty
    try {
      const task = await createTask({ workdirPath: h.workdirPath }, { title: "stale", body: "x" });
      const obs = seedGroom(h.db, task.id, "stale");
      const executed = await autoExecuteEligibleProposals(h.db, h.events, obs ? [obs] : []);
      expect(executed.size).toBe(0);
      const after = await readTaskFile({ workdirPath: h.workdirPath }, task.id);
      expect(after?.frontmatter.status).toBe("ready"); // not closed
      expect(autoRanEvents(h.published)).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("enabled + class allow-listed → auto-closes the task, records auto_ran, marks obs adopted", async () => {
    const h = setup(ENABLED);
    try {
      const task = await createTask({ workdirPath: h.workdirPath }, { title: "stale", body: "x" });
      const obs = seedGroom(h.db, task.id, "stale");
      if (!obs) throw new Error("seed failed");
      const executed = await autoExecuteEligibleProposals(h.db, h.events, [obs]);
      expect(executed.has(obs.id)).toBe(true);
      const after = await readTaskFile({ workdirPath: h.workdirPath }, task.id);
      expect(after?.frontmatter.status).toBe("dropped");
      expect(autoRanEvents(h.published)).toHaveLength(1);
      const row = h.db
        .select({ status: schema.watchObservations.status })
        .from(schema.watchObservations)
        .where(eq(schema.watchObservations.id, obs.id))
        .get();
      expect(row?.status).toBe("adopted"); // system-promoted, not left pending/surfaced
    } finally {
      h.cleanup();
    }
  });

  test("per-tick budget (default 1) → only the first eligible groom runs", async () => {
    const h = setup(ENABLED);
    try {
      const t1 = await createTask({ workdirPath: h.workdirPath }, { title: "a", body: "x" });
      const t2 = await createTask({ workdirPath: h.workdirPath }, { title: "b", body: "x" });
      const o1 = seedGroom(h.db, t1.id, "stale a");
      const o2 = seedGroom(h.db, t2.id, "stale b");
      const obs = [o1, o2].filter((o): o is NonNullable<typeof o> => Boolean(o));
      const executed = await autoExecuteEligibleProposals(h.db, h.events, obs);
      expect(executed.size).toBe(1); // maxPerTick default 1
    } finally {
      h.cleanup();
    }
  });

  test("collaborative project → nothing executes even when enabled", async () => {
    const h = setup(ENABLED);
    try {
      h.db
        .update(schema.projects)
        .set({ autonomyMode: "collaborative" })
        .where(eq(schema.projects.id, h.projectId))
        .run();
      const task = await createTask({ workdirPath: h.workdirPath }, { title: "stale", body: "x" });
      const obs = seedGroom(h.db, task.id, "stale");
      const executed = await autoExecuteEligibleProposals(h.db, h.events, obs ? [obs] : []);
      expect(executed.size).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
