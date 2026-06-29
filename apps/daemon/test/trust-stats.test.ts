import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { BUILTIN_AUTONOMY } from "../src/autonomy/config.ts";
import {
  deriveTrustRung,
  projectMergeStats,
  projectTrustState,
} from "../src/projects/trust-stats.ts";

type Mode = "collaborative" | "autonomous";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "trust-stats-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return { db: createDb(dbPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(
  db: ReturnType<typeof createDb>,
  mode: Mode,
  autonomyConfig: object | null = null,
): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: `s-${id.slice(0, 6)}`,
      name: "P",
      ceremony: "personal",
      autonomyMode: mode,
      workdirPath: `/tmp/${id}`,
      createdAt: now,
      lastActivityAt: now,
      autonomyConfig: autonomyConfig ? JSON.stringify(autonomyConfig) : null,
    })
    .run();
  return id;
}

function addRun(
  db: ReturnType<typeof createDb>,
  projectId: string,
  status: "completed" | "failed" | "aborted" | "needs_review" | "running",
  startedAt: number,
  level: string | null = null,
) {
  const id = createId();
  db.insert(schema.runs)
    .values({
      id,
      projectId,
      taskId: null,
      status,
      branch: `b-${id}`,
      worktreePath: `/tmp/wt/${id}`,
      startedAt,
      budgetSeconds: 0,
      agentName: "claude-code",
      verifierReport: level ? JSON.stringify({ score: 1, level, signals: [] }) : null,
    })
    .run();
}

describe("deriveTrustRung", () => {
  test("autonomous mode → autonomous rung", () => {
    expect(deriveTrustRung("autonomous", BUILTIN_AUTONOMY)).toBe("autonomous");
  });

  test("collaborative + autoPromote on → collaborative", () => {
    expect(deriveTrustRung("collaborative", BUILTIN_AUTONOMY)).toBe("collaborative");
  });

  test("collaborative + autoPromote off → supervised (ladder frozen)", () => {
    const frozen = {
      ...BUILTIN_AUTONOMY,
      trust: { ...BUILTIN_AUTONOMY.trust, autoPromote: false },
    };
    expect(deriveTrustRung("collaborative", frozen)).toBe("supervised");
  });
});

describe("projectTrustState", () => {
  test("reports rung, clean streak, and promote target", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      addRun(db, p, "completed", 300, "high");
      addRun(db, p, "completed", 200, "high");
      const state = projectTrustState(db, { id: p, autonomyMode: "collaborative" });
      expect(state.rung).toBe("collaborative");
      expect(state.cleanStreak).toBe(2);
      expect(state.promoteStreak).toBe(BUILTIN_AUTONOMY.trust.promoteStreak);
    } finally {
      cleanup();
    }
  });
});

describe("projectMergeStats", () => {
  test("merged% = completed ÷ decisive outcomes; today counts since local midnight", () => {
    const { db, cleanup } = setup();
    try {
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const todayTs = midnight.getTime() + 60_000;
      const yesterdayTs = midnight.getTime() - 60_000;

      const p = addProject(db, "autonomous");
      addRun(db, p, "completed", todayTs); // today, merged
      addRun(db, p, "completed", todayTs); // today, merged
      addRun(db, p, "failed", todayTs); // today, decisive but not merged
      addRun(db, p, "completed", yesterdayTs); // earlier, merged
      addRun(db, p, "needs_review", todayTs); // held — not decisive, not merged
      addRun(db, p, "running", todayTs); // in-flight — excluded from rate

      const s = projectMergeStats(db, p, now);
      expect(s.runsToday).toBe(5); // all but yesterday
      expect(s.mergedToday).toBe(2); // two completed today
      expect(s.autoMergedToday).toBe(0); // no auto_merged events
      // decisive = 3 completed + 1 failed = 4; merged = 3 completed → 75%
      expect(s.mergedPct).toBe(75);
    } finally {
      cleanup();
    }
  });

  test("counts auto_merged autonomy events today", () => {
    const { db, cleanup } = setup();
    try {
      const now = Date.now();
      const p = addProject(db, "autonomous");
      db.insert(schema.autonomyEvents)
        .values({
          id: createId(),
          projectId: p,
          runId: null,
          kind: "auto_merged",
          message: "auto-merged",
          createdAt: now - 1000,
        })
        .run();
      const s = projectMergeStats(db, p, now);
      expect(s.autoMergedToday).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("no decisive runs → mergedPct null", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      addRun(db, p, "running", Date.now());
      expect(projectMergeStats(db, p).mergedPct).toBeNull();
    } finally {
      cleanup();
    }
  });
});
