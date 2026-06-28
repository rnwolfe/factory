import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { listTasks, type TaskTarget } from "../../projects/tasks.ts";
import type { RawObservation } from "../synthesize.ts";

/**
 * In-band backlog signal (ADR-011 §2, first in-band source). Reads what a project
 * is already tracking — open tasks + active plans — so The Watch can GROOM rather
 * than duplicate. Used by the dedup pass below to honor the precision contract:
 * "never propose work that already exists."
 */

export interface ProjectBacklog {
  taskTitles: string[];
  planGoals: string[];
}

/** Proposals that materialize a trackable backlog item — only these can duplicate one. */
const WORK_PROPOSALS = new Set<RawObservation["proposal"]>(["adopt-as-task", "draft-feature-plan"]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cheap fuzzy match: equal normalized titles, or strong containment either way. */
export function titleMatches(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

export function isAlreadyTracked(backlog: ProjectBacklog, title: string): boolean {
  return [...backlog.taskTitles, ...backlog.planGoals].some((t) => titleMatches(t, title));
}

/** Read a project's open tasks + active (drafting/frozen) plans. */
export async function readProjectBacklog(
  db: Db,
  project: TaskTarget & { id: string },
): Promise<ProjectBacklog> {
  const tasks = await listTasks(project).catch(() => []);
  const taskTitles = tasks
    .filter((t) => t.frontmatter.status !== "done" && t.frontmatter.status !== "dropped")
    .map((t) => t.frontmatter.title)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  const planGoals = db
    .select({ goal: schema.plans.goal, status: schema.plans.status })
    .from(schema.plans)
    .where(eq(schema.plans.projectId, project.id))
    .all()
    .filter((p) => p.status === "drafting" || p.status === "frozen")
    .map((p) => p.goal);

  return { taskTitles, planGoals };
}

/**
 * Drop observations whose WORK proposal already exists in the target project's
 * backlog (the precision contract). Operator-level insights, conventions, notes,
 * and proposals for unknown/unresolvable projects all pass through untouched —
 * dedup only suppresses a project-scoped task/feature that's demonstrably tracked.
 */
export async function filterAlreadyTracked(
  db: Db,
  observations: RawObservation[],
): Promise<{ kept: RawObservation[]; dropped: number }> {
  const cache = new Map<string, ProjectBacklog>();
  const kept: RawObservation[] = [];
  let dropped = 0;

  for (const o of observations) {
    if (!o.targetProjectSlug || !WORK_PROPOSALS.has(o.proposal)) {
      kept.push(o);
      continue;
    }
    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.slug, o.targetProjectSlug))
      .get();
    if (!project) {
      kept.push(o); // can't resolve → can't dedup; surfacing is still useful
      continue;
    }
    let backlog = cache.get(project.id);
    if (!backlog) {
      backlog = await readProjectBacklog(db, project);
      cache.set(project.id, backlog);
    }
    if (isAlreadyTracked(backlog, o.title)) {
      dropped += 1;
      continue;
    }
    kept.push(o);
  }
  return { kept, dropped };
}
