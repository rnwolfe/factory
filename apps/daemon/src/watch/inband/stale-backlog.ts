import { type Db, schema } from "@factory/db";
import { listTasks } from "../../projects/tasks.ts";
import type { RawObservation } from "../synthesize.ts";

/** A `ready` task untouched this long is probably obsolete or forgotten. */
const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/**
 * In-band groom detector (ADR-011 §2): surface long-idle `ready` tasks so the
 * backlog reflects real intent. Emits a `groom-backlog` proposal carrying the
 * target task id; approving it closes the task (the operator gates the close).
 * Idempotent across cadences via the content dedupe-key, and it stops firing once
 * the task leaves `ready`.
 */
export async function detectStaleBacklogSignals(db: Db): Promise<RawObservation[]> {
  const projects = db.select().from(schema.projects).all();
  const staleBefore = Date.now() - STALE_DAYS * DAY_MS;
  const out: RawObservation[] = [];

  for (const p of projects) {
    const tasks = await listTasks(p).catch(() => []);
    for (const t of tasks) {
      if (t.frontmatter.status !== "ready") continue;
      const stamp = t.frontmatter.updated ?? t.frontmatter.created;
      const ts = stamp ? Date.parse(stamp) : Number.NaN;
      if (Number.isNaN(ts) || ts >= staleBefore) continue;
      const ageDays = Math.floor((Date.now() - ts) / DAY_MS);
      out.push({
        kind: "stale-backlog",
        title: `Stale task on ${p.slug}: ${t.frontmatter.title}`,
        detail: `This ready task hasn't been touched in ${ageDays} days. If it's obsolete or superseded, close it so the backlog reflects real intent; otherwise bump its priority.`,
        evidence: [],
        proposal: "groom-backlog",
        targetProjectSlug: p.slug,
        targetTaskId: t.id,
      });
    }
  }
  return out;
}
