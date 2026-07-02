import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { and, eq, inArray, ne } from "drizzle-orm";
import YAML from "yaml";
import type { FactoryConfig } from "../config.ts";

/** Slug derivation — identical rules to bootstrap/import (kebab, ≤48 chars). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

export class LifecycleError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "running_run"
      | "no_workdir"
      | "has_worktrees"
      | "slug_taken"
      | "invalid_name",
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface RenameResult {
  name: string;
  slug: string;
  workdirPath: string;
  /** True when the on-disk directory was moved (factory-managed projects only). */
  movedDir: boolean;
}

/**
 * Rename a project: update `name` + `slug`, and — for factory-managed projects
 * (workdir under the factory root) — move the on-disk directory to match the new
 * slug. `workdirPath` is the single source of truth for the project's location
 * (nothing re-derives it from slug at runtime), so the DB update + dir move is
 * sufficient for the project dir; the on-disk `.factory/meta.yaml` slug and any
 * Watch-observation `targetProjectSlug` soft-references are updated to match.
 *
 * Refuses when a run is active OR when the project has worktrees on disk
 * (`<worktreesRoot>/<slug>/…`): worktrees embed the slug in their path and their
 * git admin links, and relocating them safely is out of scope for v1 — the
 * operator runs `factory prune` (or finishes/aborts runs) first. Imported
 * projects (external workdir) get the name/slug change but the external dir is
 * left in place.
 */
export async function renameProject(
  config: FactoryConfig,
  db: Db,
  projectId: string,
  newName: string,
): Promise<RenameResult> {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new LifecycleError("not_found", `project ${projectId} not found`);

  const trimmed = newName.trim();
  const newSlug = slugify(trimmed);
  if (!trimmed || !newSlug) {
    throw new LifecycleError("invalid_name", "name must contain at least one letter or digit");
  }

  const slugChanged = newSlug !== project.slug;

  // Refuse while a run is in flight (would strand its live worktree + tmux).
  const runs = db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .all();
  const stuck = runs.find((r) => r.status === "running" || r.status === "queued");
  if (stuck) {
    throw new LifecycleError(
      "running_run",
      `run ${stuck.id} is ${stuck.status} — abort it before renaming the project`,
    );
  }

  // Refuse if worktrees exist on disk under the current slug (v1 scope).
  if (slugChanged) {
    const wtDir = path.join(config.worktreesRoot, project.slug);
    if (existsSync(wtDir)) {
      let entries: string[] = [];
      try {
        entries = await readdir(wtDir);
      } catch {
        // ignore
      }
      if (entries.length > 0) {
        throw new LifecycleError(
          "has_worktrees",
          `project has ${entries.length} worktree(s) on disk — run \`factory prune\` before renaming`,
        );
      }
    }
  }

  // Slug uniqueness (mirror the DB unique constraint with a clean error).
  if (slugChanged) {
    const clash = db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.slug, newSlug), ne(schema.projects.id, projectId)))
      .get();
    if (clash) {
      throw new LifecycleError("slug_taken", `another project already uses the slug "${newSlug}"`);
    }
  }

  // Move the on-disk dir for factory-managed projects only.
  const factoryRoot = path.resolve(config.workdir);
  const workdirAbs = path.resolve(project.workdirPath);
  const insideRoot =
    workdirAbs === factoryRoot || workdirAbs.startsWith(`${factoryRoot}${path.sep}`);
  let newWorkdirPath = project.workdirPath;
  let movedDir = false;
  if (slugChanged && insideRoot) {
    newWorkdirPath = path.join(factoryRoot, "projects", newSlug);
    if (existsSync(newWorkdirPath)) {
      throw new LifecycleError("slug_taken", `directory already exists: ${newWorkdirPath}`);
    }
    if (existsSync(workdirAbs)) {
      await rename(workdirAbs, newWorkdirPath);
      movedDir = true;
    }
  }

  db.update(schema.projects)
    .set({ name: trimmed, slug: newSlug, workdirPath: newWorkdirPath, lastActivityAt: Date.now() })
    .where(eq(schema.projects.id, projectId))
    .run();

  // Keep the on-disk meta.yaml slug in sync (best-effort).
  if (slugChanged) {
    const metaPath = path.join(newWorkdirPath, ".factory", "meta.yaml");
    if (existsSync(metaPath)) {
      try {
        const meta = (YAML.parse(await readFile(metaPath, "utf8")) ?? {}) as Record<
          string,
          unknown
        >;
        meta.slug = newSlug;
        await writeFile(metaPath, YAML.stringify(meta), "utf8");
      } catch {
        // best-effort — the DB slug is authoritative
      }
    }
    // Re-point Watch observations' soft slug FK so they still resolve.
    db.update(schema.watchObservations)
      .set({ targetProjectSlug: newSlug })
      .where(eq(schema.watchObservations.targetProjectSlug, project.slug))
      .run();
  }

  return { name: trimmed, slug: newSlug, workdirPath: newWorkdirPath, movedDir };
}

export interface DeletePreview {
  workdirPath: string;
  workdirInsideFactoryRoot: boolean;
  worktreeCount: number;
  worktreeSlugDir: string | null;
  approvedReportPaths: string[];
}

export interface DeleteResult {
  removedWorkdir: boolean;
  removedWorktreeCount: number;
  /** Counts of cascade-deleted DB rows, for logging. */
  removedRows: {
    runs: number;
    audits: number;
    auditComments: number;
    plans: number;
    planComments: number;
    decisions: number;
    decisionComments: number;
    events: number;
    metrics: number;
  };
}

/**
 * Compute a preview of what `deleteProject` will remove. Used by the PWA's
 * typed-confirm modal so the operator sees the blast radius before clicking.
 */
export async function previewDelete(
  config: FactoryConfig,
  db: Db,
  projectId: string,
): Promise<DeletePreview> {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) {
    throw new LifecycleError("not_found", `project ${projectId} not found`);
  }
  const factoryRoot = path.resolve(config.workdir);
  const workdirAbs = path.resolve(project.workdirPath);
  const workdirInsideFactoryRoot =
    workdirAbs === factoryRoot || workdirAbs.startsWith(`${factoryRoot}${path.sep}`);

  const worktreeSlugDir = path.join(config.worktreesRoot, project.slug);
  let worktreeCount = 0;
  if (existsSync(worktreeSlugDir)) {
    try {
      const entries = await readdir(worktreeSlugDir);
      worktreeCount = entries.length;
    } catch {
      worktreeCount = 0;
    }
  }

  // Approved audit reports live in the workdir at docs/internal/audits/.
  const approvedReportPaths: string[] = [];
  const auditRows = db
    .select({ p: schema.audits.approvedReportPath })
    .from(schema.audits)
    .where(eq(schema.audits.projectId, projectId))
    .all();
  for (const r of auditRows) {
    if (r.p) approvedReportPaths.push(r.p);
  }

  return {
    workdirPath: project.workdirPath,
    workdirInsideFactoryRoot,
    worktreeCount,
    worktreeSlugDir: existsSync(worktreeSlugDir) ? worktreeSlugDir : null,
    approvedReportPaths,
  };
}

/** Soft-archive: tag=past + archivedAt=now. Idempotent. */
export function archiveProject(db: Db, projectId: string): { ok: true } {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) {
    throw new LifecycleError("not_found", `project ${projectId} not found`);
  }
  db.update(schema.projects)
    .set({ tag: "past", archivedAt: Date.now(), lastActivityAt: Date.now() })
    .where(eq(schema.projects.id, projectId))
    .run();
  return { ok: true };
}

/** Inverse of archive. Idempotent. */
export function unarchiveProject(db: Db, projectId: string): { ok: true } {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) {
    throw new LifecycleError("not_found", `project ${projectId} not found`);
  }
  db.update(schema.projects)
    .set({ tag: "active", archivedAt: null, lastActivityAt: Date.now() })
    .where(eq(schema.projects.id, projectId))
    .run();
  return { ok: true };
}

/**
 * Hard delete. Refuses if any run is running/queued. Cascade-deletes all
 * project-scoped rows, then optionally rms the workdir (only when it lives
 * under config.workdir — imported-by-path projects keep their repos) and
 * the worktree directory under config.worktreesRoot.
 */
export async function deleteProject(
  config: FactoryConfig,
  db: Db,
  projectId: string,
  opts: { removeWorkdir: boolean },
): Promise<DeleteResult> {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) {
    throw new LifecycleError("not_found", `project ${projectId} not found`);
  }

  // Refuse if any run is in flight.
  const live = db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .all();
  const stuck = live.find((r) => r.status === "running" || r.status === "queued");
  if (stuck) {
    throw new LifecycleError(
      "running_run",
      `run ${stuck.id} is ${stuck.status} — abort it before deleting the project`,
    );
  }

  // Collect IDs once so the deletion order is deterministic and we can wipe
  // polymorphic claude_metrics and events without joining at delete time.
  const runIds = live.map((r) => r.id);
  const auditIds = db
    .select({ id: schema.audits.id })
    .from(schema.audits)
    .where(eq(schema.audits.projectId, projectId))
    .all()
    .map((r) => r.id);
  const planIds = db
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.projectId, projectId))
    .all()
    .map((r) => r.id);
  const decisionIds = db
    .select({ id: schema.decisions.id })
    .from(schema.decisions)
    .where(eq(schema.decisions.projectId, projectId))
    .all()
    .map((r) => r.id);

  const removed: DeleteResult["removedRows"] = {
    runs: 0,
    audits: 0,
    auditComments: 0,
    plans: 0,
    planComments: 0,
    decisions: 0,
    decisionComments: 0,
    events: 0,
    metrics: 0,
  };

  db.transaction((tx) => {
    if (runIds.length > 0) {
      removed.events += tx
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(inArray(schema.events.runId, runIds))
        .all().length;
      tx.delete(schema.events).where(inArray(schema.events.runId, runIds)).run();
    }

    if (auditIds.length > 0) {
      removed.auditComments += tx
        .select({ id: schema.auditComments.id })
        .from(schema.auditComments)
        .where(inArray(schema.auditComments.auditId, auditIds))
        .all().length;
      tx.delete(schema.auditComments).where(inArray(schema.auditComments.auditId, auditIds)).run();
    }

    if (planIds.length > 0) {
      removed.planComments += tx
        .select({ id: schema.planComments.id })
        .from(schema.planComments)
        .where(inArray(schema.planComments.planId, planIds))
        .all().length;
      tx.delete(schema.planComments).where(inArray(schema.planComments.planId, planIds)).run();
    }

    if (decisionIds.length > 0) {
      removed.decisionComments += tx
        .select({ id: schema.decisionComments.id })
        .from(schema.decisionComments)
        .where(inArray(schema.decisionComments.decisionId, decisionIds))
        .all().length;
      tx.delete(schema.decisionComments)
        .where(inArray(schema.decisionComments.decisionId, decisionIds))
        .run();
    }

    // Polymorphic metrics: delete by (ownerKind, ownerId) for each owner kind
    // we know about, plus by projectId for any not yet covered.
    const metricsOwnerSets: Array<{
      kinds: Array<
        | "run"
        | "audit"
        | "audit_exec"
        | "audit_promote"
        | "audit_comment"
        | "plan_iteration"
        | "triage"
      >;
      ids: string[];
    }> = [
      { kinds: ["run"], ids: runIds },
      { kinds: ["audit", "audit_exec", "audit_promote", "audit_comment"], ids: auditIds },
      { kinds: ["plan_iteration"], ids: planIds },
      { kinds: ["triage"], ids: decisionIds },
    ];
    for (const set of metricsOwnerSets) {
      if (set.ids.length === 0) continue;
      removed.metrics += tx
        .select({ id: schema.claudeMetrics.id })
        .from(schema.claudeMetrics)
        .where(
          and(
            inArray(schema.claudeMetrics.ownerKind, set.kinds),
            inArray(schema.claudeMetrics.ownerId, set.ids),
          ),
        )
        .all().length;
      tx.delete(schema.claudeMetrics)
        .where(
          and(
            inArray(schema.claudeMetrics.ownerKind, set.kinds),
            inArray(schema.claudeMetrics.ownerId, set.ids),
          ),
        )
        .run();
    }
    removed.metrics += tx
      .select({ id: schema.claudeMetrics.id })
      .from(schema.claudeMetrics)
      .where(eq(schema.claudeMetrics.projectId, projectId))
      .all().length;
    tx.delete(schema.claudeMetrics).where(eq(schema.claudeMetrics.projectId, projectId)).run();

    // Now the parent rows.
    if (runIds.length > 0) {
      removed.runs += runIds.length;
      tx.delete(schema.runs).where(inArray(schema.runs.id, runIds)).run();
    }
    if (auditIds.length > 0) {
      removed.audits += auditIds.length;
      tx.delete(schema.audits).where(inArray(schema.audits.id, auditIds)).run();
    }
    if (planIds.length > 0) {
      removed.plans += planIds.length;
      tx.delete(schema.plans).where(inArray(schema.plans.id, planIds)).run();
    }
    if (decisionIds.length > 0) {
      removed.decisions += decisionIds.length;
      tx.delete(schema.decisions).where(inArray(schema.decisions.id, decisionIds)).run();
    }

    tx.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
  });

  // Filesystem cleanup happens outside the DB transaction. Failures here are
  // surfaced but DB rows are already gone — best-effort.
  let removedWorktreeCount = 0;
  const slugDir = path.join(config.worktreesRoot, project.slug);
  if (existsSync(slugDir)) {
    let entries: string[] = [];
    try {
      entries = await readdir(slugDir);
    } catch {
      // ignore
    }
    for (const entry of entries) {
      const wtPath = path.join(slugDir, entry);
      // Best-effort `git worktree remove` against the project workdir if it
      // still exists. If the workdir is already gone (e.g. previous deletion
      // attempt), skip and rely on rm.
      if (existsSync(project.workdirPath)) {
        await git(["worktree", "remove", "--force", wtPath], project.workdirPath);
      }
      if (existsSync(wtPath)) {
        try {
          await rm(wtPath, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      removedWorktreeCount++;
    }
    try {
      await rm(slugDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  let removedWorkdir = false;
  if (opts.removeWorkdir) {
    const factoryRoot = path.resolve(config.workdir);
    const workdirAbs = path.resolve(project.workdirPath);
    const insideFactoryRoot =
      workdirAbs === factoryRoot || workdirAbs.startsWith(`${factoryRoot}${path.sep}`);
    if (insideFactoryRoot && existsSync(workdirAbs)) {
      try {
        await rm(workdirAbs, { recursive: true, force: true });
        removedWorkdir = true;
      } catch {
        // ignore — fs operations on imported repos may fail if outside our root
      }
    }
  }

  return {
    removedWorkdir,
    removedWorktreeCount,
    removedRows: removed,
  };
}
