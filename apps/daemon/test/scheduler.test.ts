import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { EventBus } from "../src/events.ts";
import { createDbCursorStore } from "../src/watch/cursor-store.ts";
import type { HarnessSource } from "../src/watch/sources/types.ts";
import { createSynthesisJob, readWatchSynthesisCadence } from "../src/watch/synthesis-job.ts";
import { startScheduler } from "../src/workers/scheduler.ts";

const HOUR = 60 * 60_000;
const flush = () => new Promise<void>((r) => setTimeout(r, 1));

// No-op synthesis collaborators for tests that only exercise scan/cursor flow.
const NOOP_SYNTH = {
  synthesize: async () => [],
  saveObservations: () => ({ inserted: 0, skipped: 0 }),
};

describe("startScheduler", () => {
  test("runs a time-cadence job once per interval, not on boot", async () => {
    const t0 = 1_700_000_000_000;
    let calls = 0;
    const sched = startScheduler({
      events: new EventBus(),
      jobs: [{ id: "j", cadence: () => "hourly", run: async () => void calls++ }],
      now: () => t0,
      tickMs: 1e9,
    });
    try {
      sched.runDue(t0); // boot: seeded lastRun == t0, nothing due
      expect(calls).toBe(0);
      sched.runDue(t0 + HOUR);
      await flush();
      expect(calls).toBe(1);
      sched.runDue(t0 + HOUR + HOUR / 2); // not yet a full interval
      await flush();
      expect(calls).toBe(1);
      sched.runDue(t0 + 2 * HOUR);
      await flush();
      expect(calls).toBe(2);
    } finally {
      sched.stop();
    }
  });

  test('cadence "off" never runs', async () => {
    const t0 = 1_700_000_000_000;
    let calls = 0;
    const sched = startScheduler({
      events: new EventBus(),
      jobs: [{ id: "off", cadence: () => "off", run: async () => void calls++ }],
      now: () => t0,
      tickMs: 1e9,
    });
    try {
      sched.runDue(t0 + 1000 * HOUR);
      await flush();
      expect(calls).toBe(0);
    } finally {
      sched.stop();
    }
  });

  test("skip-if-inflight: an unfinished run is not re-dispatched", async () => {
    const t0 = 1_700_000_000_000;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sched = startScheduler({
      events: new EventBus(),
      jobs: [
        {
          id: "slow",
          cadence: () => "hourly",
          run: async () => {
            started++;
            await gate;
          },
        },
      ],
      now: () => t0,
      tickMs: 1e9,
    });
    try {
      sched.runDue(t0 + HOUR); // dispatch; job awaits the gate
      await flush();
      expect(started).toBe(1);
      sched.runDue(t0 + 2 * HOUR); // still inflight → skipped
      await flush();
      expect(started).toBe(1);
      release(); // let the first run finish
      await flush();
      sched.runDue(t0 + 3 * HOUR); // now free → runs again
      await flush();
      expect(started).toBe(2);
    } finally {
      release();
      sched.stop();
    }
  });

  test("event-triggered job fires on a matching DaemonEvent kind", async () => {
    const events = new EventBus();
    let calls = 0;
    const sched = startScheduler({
      events,
      jobs: [{ id: "ev", events: new Set(["plan_frozen"]), run: async () => void calls++ }],
      tickMs: 1e9,
    });
    try {
      events.publish({ channel: "pane", runId: "x", bytes: new Uint8Array() }); // no kind → ignored
      await flush();
      expect(calls).toBe(0);
      events.publish({
        channel: "inbox",
        kind: "plan_frozen",
        planId: "p1",
      } as unknown as Parameters<typeof events.publish>[0]);
      await flush();
      expect(calls).toBe(1);
    } finally {
      sched.stop();
    }
  });
});

describe("createSynthesisJob", () => {
  test("scans every source and threads each source's cursor across runs", async () => {
    let calls = 0;
    let lastCursorPos: string | null | undefined;
    const fake: HarnessSource = {
      id: "fake",
      label: "Fake",
      isAvailable: async () => true,
      async scan(cursor) {
        calls++;
        lastCursorPos = cursor?.position ?? null;
        return {
          records: calls === 1 ? [stubRecord(), stubRecord()] : [],
          next: { sourceId: "fake", position: `p${calls}` },
        };
      },
      readMemories: async () => [],
    };
    const job = createSynthesisJob({
      cadence: () => "daily",
      listSources: async () => [fake],
      ...NOOP_SYNTH,
    });

    await job.run(); // first scan: cursor is the lookback default
    expect(calls).toBe(1);
    expect(lastCursorPos).toBeTypeOf("string"); // a lookback timestamp, not null

    await job.run(); // second scan: cursor threaded from the first scan's `next`
    expect(calls).toBe(2);
    expect(lastCursorPos).toBe("p1");
  });

  test("a throwing source does not sink the whole run", async () => {
    const bad: HarnessSource = {
      id: "bad",
      label: "Bad",
      isAvailable: async () => true,
      scan: async () => {
        throw new Error("boom");
      },
      readMemories: async () => [],
    };
    const job = createSynthesisJob({
      cadence: () => "daily",
      listSources: async () => [bad],
      ...NOOP_SYNTH,
    });
    await expect(job.run()).resolves.toBeUndefined();
  });
});

describe("readWatchSynthesisCadence", () => {
  test("defaults to daily and accepts valid values, rejects junk", () => {
    const root = mkdtempSync(path.join(tmpdir(), "watch-cadence-"));
    try {
      const dbPath = path.join(root, "data.db");
      runMigrations(dbPath);
      const db = createDb(dbPath);

      expect(readWatchSynthesisCadence(db)).toBe("daily"); // unset → default

      db.insert(schema.settings)
        .values({ key: "watch-synthesis-cadence", value: "hourly", updatedAt: Date.now() })
        .run();
      expect(readWatchSynthesisCadence(db)).toBe("hourly");

      db.update(schema.settings)
        .set({ value: "nonsense" })
        .where(eq(schema.settings.key, "watch-synthesis-cadence"))
        .run();
      expect(readWatchSynthesisCadence(db)).toBe("daily"); // invalid → default
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createDbCursorStore", () => {
  test("roundtrips and upserts a per-source cursor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "watch-cursor-"));
    try {
      const dbPath = path.join(root, "data.db");
      runMigrations(dbPath);
      const store = createDbCursorStore(createDb(dbPath));

      expect(store.get("claude-code")).toBeNull();
      store.set({ sourceId: "claude-code", position: "2026-06-01T00:00:00.000Z" });
      expect(store.get("claude-code")?.position).toBe("2026-06-01T00:00:00.000Z");
      store.set({ sourceId: "claude-code", position: "2026-06-02T00:00:00.000Z" }); // upsert
      expect(store.get("claude-code")?.position).toBe("2026-06-02T00:00:00.000Z");
      expect(store.get("codex")).toBeNull(); // isolated per source
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fresh synthesis job resumes from the persisted cursor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "watch-durable-"));
    try {
      const dbPath = path.join(root, "data.db");
      runMigrations(dbPath);
      const store = createDbCursorStore(createDb(dbPath));

      let calls = 0;
      let seenCursorPos: string | null | undefined;
      const fake: HarnessSource = {
        id: "fake",
        label: "Fake",
        isAvailable: async () => true,
        async scan(cursor) {
          calls++;
          seenCursorPos = cursor?.position ?? null;
          // First scan yields a record so the cursor commits (cursors advance
          // only after a non-empty synthesis); the second sees nothing new.
          return {
            records: calls === 1 ? [stubRecord()] : [],
            next: { sourceId: "fake", position: `p${calls}` },
          };
        },
        readMemories: async () => [],
      };

      // First job instance writes p1 to the durable store.
      await createSynthesisJob({
        cadence: () => "daily",
        listSources: async () => [fake],
        cursors: store,
        ...NOOP_SYNTH,
      }).run();

      // A brand-new job instance (simulating a daemon restart) must read p1 from
      // the store, not fall back to the lookback default.
      await createSynthesisJob({
        cadence: () => "daily",
        listSources: async () => [fake],
        cursors: store,
        ...NOOP_SYNTH,
      }).run();

      expect(calls).toBe(2);
      expect(seenCursorPos).toBe("p1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function stubRecord() {
  return {
    sourceId: "fake",
    sessionId: "s",
    projectPath: null,
    gitBranch: null,
    startedAt: 0,
    endedAt: null,
    title: "t",
    summary: "",
    signals: [],
  };
}
