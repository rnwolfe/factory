import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { BUILTIN_AUTONOMY } from "../src/autonomy/config.ts";
import {
  autoContract,
  cleanStreak,
  evaluateTrustOnOutcome,
  maybeAutoPromote,
} from "../src/workers/trust-ladder.ts";

const PROMOTE_STREAK = BUILTIN_AUTONOMY.trust.promoteStreak;

type Mode = "collaborative" | "autonomous";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "trust-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return { db: createDb(dbPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(db: ReturnType<typeof createDb>, mode: Mode): string {
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
    })
    .run();
  return id;
}

function addRun(
  db: ReturnType<typeof createDb>,
  projectId: string,
  status: "completed" | "failed" | "needs_review",
  level: string | null,
  startedAt: number,
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
      baseRef: "abc1234",
      agentName: "claude-code",
      summary: null,
      verifierReport: level ? JSON.stringify({ score: 1, level, signals: [] }) : null,
    })
    .run();
}

function modeOf(db: ReturnType<typeof createDb>, id: string): string | undefined {
  return db
    .select({ m: schema.projects.autonomyMode })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get()?.m;
}

const proj = (id: string, mode: Mode) => ({ id, name: "P", autonomyMode: mode });

describe("cleanStreak", () => {
  test("counts leading completed+high runs; breaks on the first non-clean", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      addRun(db, p, "completed", "high", 100);
      addRun(db, p, "completed", "high", 200);
      addRun(db, p, "completed", "medium", 300); // most recent isn't `high`
      expect(cleanStreak(db, p)).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("all clean → full streak", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      for (let i = 0; i < 6; i++) addRun(db, p, "completed", "high", 100 + i);
      expect(cleanStreak(db, p)).toBe(6);
    } finally {
      cleanup();
    }
  });

  test("a failed run breaks the streak", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      addRun(db, p, "completed", "high", 100);
      addRun(db, p, "failed", null, 200); // most recent
      expect(cleanStreak(db, p)).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("autoContract", () => {
  test("autonomous → collaborative (returns true)", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "autonomous");
      expect(autoContract(db, proj(p, "autonomous"), "x")).toBe(true);
      expect(modeOf(db, p)).toBe("collaborative");
    } finally {
      cleanup();
    }
  });

  test("already collaborative → no-op (false)", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      expect(autoContract(db, proj(p, "collaborative"), "x")).toBe(false);
      expect(modeOf(db, p)).toBe("collaborative");
    } finally {
      cleanup();
    }
  });
});

describe("maybeAutoPromote", () => {
  test("collaborative + clean streak ≥ N → autonomous", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      for (let i = 0; i < PROMOTE_STREAK; i++) addRun(db, p, "completed", "high", 100 + i);
      expect(maybeAutoPromote(db, proj(p, "collaborative"))).toBe(true);
      expect(modeOf(db, p)).toBe("autonomous");
    } finally {
      cleanup();
    }
  });

  test("short streak → no-op", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      for (let i = 0; i < PROMOTE_STREAK - 1; i++) addRun(db, p, "completed", "high", 100 + i);
      expect(maybeAutoPromote(db, proj(p, "collaborative"))).toBe(false);
      expect(modeOf(db, p)).toBe("collaborative");
    } finally {
      cleanup();
    }
  });
});

describe("evaluateTrustOnOutcome", () => {
  test("a failed run contracts an autonomous project", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "autonomous");
      evaluateTrustOnOutcome(db, proj(p, "autonomous"), {
        finalStatus: "failed",
        mergeConflict: false,
      });
      expect(modeOf(db, p)).toBe("collaborative");
    } finally {
      cleanup();
    }
  });

  test("a merge conflict contracts an autonomous project", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "autonomous");
      evaluateTrustOnOutcome(db, proj(p, "autonomous"), {
        finalStatus: "completed",
        mergeConflict: true,
      });
      expect(modeOf(db, p)).toBe("collaborative");
    } finally {
      cleanup();
    }
  });

  test("needs_review is neutral — the gate working, not a failure", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "autonomous");
      evaluateTrustOnOutcome(db, proj(p, "autonomous"), {
        finalStatus: "needs_review",
        mergeConflict: false,
      });
      expect(modeOf(db, p)).toBe("autonomous"); // unchanged
    } finally {
      cleanup();
    }
  });

  test("a clean completion promotes after the streak is earned", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "collaborative");
      for (let i = 0; i < PROMOTE_STREAK; i++) addRun(db, p, "completed", "high", 100 + i);
      evaluateTrustOnOutcome(db, proj(p, "collaborative"), {
        finalStatus: "completed",
        mergeConflict: false,
      });
      expect(modeOf(db, p)).toBe("autonomous");
    } finally {
      cleanup();
    }
  });
});
