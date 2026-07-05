import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AuditSkillFrontmatter,
  type Ceremony,
  createDb,
  runMigrations,
  schema,
  type Tag,
} from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { type AuditCadenceDeps, tickAuditCadence } from "../src/workers/audit-cadence.ts";

/**
 * The audit-cadence tick (ADR-004, amended). These lock the load-bearing
 * guardrails: off-by-default, tier/active/skill eligibility, skip-if-inflight,
 * and the emergencyStop kill-switch. `submit` and `listSkills` are injected so
 * the tick's selection logic is exercised without spawning an agent.
 */

type Db = ReturnType<typeof createDb>;
const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;
const T0 = 1_700_000_000_000;

function freshDb(root: string): Db {
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return createDb(dbPath);
}

function seedProject(
  db: Db,
  opts: {
    ceremony?: Ceremony;
    tag?: Tag;
    /** Per-project autonomy override blob (JSON). */
    autonomyConfig?: unknown;
  } = {},
): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: `p-${id.slice(0, 6)}`,
      name: "p",
      ceremony: opts.ceremony ?? "personal",
      tag: opts.tag ?? "active",
      workdirPath: `/tmp/${id}`,
      autonomyConfig: opts.autonomyConfig ? JSON.stringify(opts.autonomyConfig) : null,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

/** Insert a raw audit row (used to stage in-flight + last-run state). */
function seedAudit(
  db: Db,
  projectId: string,
  opts: { skillName?: string; status?: "running" | "completed"; startedAt: number },
): void {
  db.insert(schema.audits)
    .values({
      id: createId(),
      projectId,
      skillName: opts.skillName ?? "docs-audit",
      skillVersion: "v",
      status: opts.status ?? "completed",
      startedAt: opts.startedAt,
      completedAt: opts.status === "running" ? null : opts.startedAt + 1000,
    })
    .run();
}

const skill = (name: string): AuditSkillFrontmatter => ({
  name,
  description: "",
  kind: "read-only",
  needsWorktree: false,
  defaultSeverityGrade: "enabled",
});

/** Build tick deps with a recording `submit` and a fixed installed-skill list. */
function makeDeps(
  db: Db,
  fired: Array<{ projectId: string; skillName: string }>,
  skills: AuditSkillFrontmatter[] = [skill("docs-audit")],
): AuditCadenceDeps {
  const projects = new Map<string, string>();
  for (const p of db.select().from(schema.projects).all()) projects.set(p.workdirPath, p.id);
  return {
    db,
    config: {} as unknown as FactoryConfig,
    events: new EventBus(),
    listSkills: async () => skills,
    submit: async (project, skillName) => {
      fired.push({ projectId: project.id, skillName });
    },
  };
}

/** Opt a project into weekly audit cadence. */
const OPT_IN = { audit: { cadence: "weekly" } };

describe("tickAuditCadence", () => {
  test("off by default: an eligible project with no opt-in never fires", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      seedProject(db, { ceremony: "personal" }); // no autonomyConfig → cadence "off"
      const fired: Array<{ projectId: string; skillName: string }> = [];
      const n = await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR);
      expect(n).toBe(0);
      expect(fired).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opted-in personal+active+has-skill project fires one audit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      const p = seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      const n = await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR);
      expect(n).toBe(1);
      expect(fired).toEqual([{ projectId: p, skillName: "docs-audit" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tier gate: an opted-in tinker project is skipped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      seedProject(db, { ceremony: "tinker", autonomyConfig: OPT_IN });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      expect(await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archived (tag != active) opted-in project is skipped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      seedProject(db, { ceremony: "personal", tag: "past", autonomyConfig: OPT_IN });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      expect(await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no installed skill → nothing to fire", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      const deps = makeDeps(db, fired, []); // no installed skills
      expect(await tickAuditCadence(deps, T0 + WEEK + HOUR)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skip-if-inflight: a project with a running audit is skipped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      const p = seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      seedAudit(db, p, { status: "running", startedAt: T0 }); // in flight
      const fired: Array<{ projectId: string; skillName: string }> = [];
      expect(await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emergencyStop short-circuits the whole tick", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      // System-level kill-switch.
      db.insert(schema.settings)
        .values({
          key: "autonomy-config",
          value: JSON.stringify({ autorun: { emergencyStop: true } }),
          updatedAt: Date.now(),
        })
        .run();
      const fired: Array<{ projectId: string; skillName: string }> = [];
      expect(await tickAuditCadence(makeDeps(db, fired), T0 + WEEK + HOUR)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("due-ness: a recently-run skill is not due; a never-run one is", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      const p = seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      // docs-audit ran an hour ago (not due under weekly); drift-check never ran.
      const at = T0 + WEEK + HOUR;
      seedAudit(db, p, { skillName: "docs-audit", status: "completed", startedAt: at - HOUR });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      const deps = makeDeps(db, fired, [skill("docs-audit"), skill("drift-check")]);
      const n = await tickAuditCadence(deps, at);
      expect(n).toBe(1);
      // Only the never-run, most-overdue skill fires.
      expect(fired).toEqual([{ projectId: p, skillName: "drift-check" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all skills recently run → project is not due", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "audit-cadence-"));
    try {
      const db = freshDb(root);
      const p = seedProject(db, { ceremony: "personal", autonomyConfig: OPT_IN });
      const at = T0 + WEEK + HOUR;
      seedAudit(db, p, { skillName: "docs-audit", status: "completed", startedAt: at - HOUR });
      const fired: Array<{ projectId: string; skillName: string }> = [];
      expect(await tickAuditCadence(makeDeps(db, fired), at)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
