import type { Db } from "@factory/db";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import {
  dependencyCycleExists,
  listTasks,
  normalizeBlockedBy,
  readTaskFile,
  type TaskFile,
  type TaskFrontmatter,
  type TaskTarget,
  tasksById,
  updateTaskBlockedBy,
  updateTaskPriority,
} from "./tasks.ts";

/** Terminal task statuses — excluded from the organizable backlog. */
const TERMINAL_STATUSES = new Set<TaskFrontmatter["status"]>(["done", "dropped"]);

/**
 * Import-time enrichment (ADR-021 companion to the reap flow): after adopting a
 * batch of pre-existing upstream issues, read each one and infer its
 * organization from the prose — `blockedBy` dependency edges among the adopted
 * set, and `priority` — then apply it so the operator inherits a pre-organized
 * backlog instead of a flat one. Adopted work stays `needs_triage` (ADR-020), so
 * the operator still vets before anything runs; this just fills in the structure
 * the issue descriptions already imply ("depends on", "Phase 3", "prerequisite
 * that isn't built", "relates #268").
 *
 * Best-effort and safe: a model/parse failure leaves the adopted tasks untouched
 * (never throws to the caller); inferred edges are scoped strictly to the adopted
 * set, self/dupes stripped, and cycles rejected — so nothing it emits can corrupt
 * the queue or deadlock auto-advance.
 */

const PRIORITIES = new Set<NonNullable<TaskFrontmatter["priority"]>>(["high", "med", "low"]);
const BODY_CAP = 1800;

export interface ImportEnrichmentResult {
  /** Tasks whose `blockedBy` was set from inference. */
  edgesApplied: number;
  /** Tasks whose `priority` was set from inference. */
  prioritiesApplied: number;
  /** True when the model call/parse failed (no changes made). */
  inferenceFailed: boolean;
}

interface InferredTask {
  id?: string | number;
  number?: string | number;
  priority?: string;
  blockedBy?: Array<string | number>;
}

/** Present the adopted issue set for inference. Ids are the real issue numbers. */
function buildPrompt(tasks: TaskFile[]): string {
  const blocks = tasks.map((t) => {
    const body = (t.body ?? "").trim().slice(0, BODY_CAP);
    return `### Issue ${t.id}: ${t.frontmatter.title}\n${body || "(no description)"}`;
  });
  const ids = tasks.map((t) => t.id).join(", ");
  return [
    "You are organizing a batch of GitHub issues that were just imported into a task tracker.",
    "Infer each issue's PRIORITY and its DEPENDENCIES (which other issues in THIS batch it is",
    "blocked by / must come after) purely from the descriptions below.",
    "",
    "Rules:",
    `- Only reference issue ids from this exact set: [${ids}]. Never invent ids or reference issues outside the batch.`,
    "- Add a `blockedBy` edge ONLY when the text clearly implies a dependency, prerequisite, or",
    '  ordering (e.g. "depends on", "requires", "prerequisite", "after X", "Phase 3" following',
    '  "Phase 2", "relates #N" where N is a foundation it builds on). Be conservative — when in',
    "  doubt, no edge. Do not create cycles.",
    '- priority is one of "high" | "med" | "low", inferred from impact/urgency/foundational-ness',
    "  (foundational or explicitly-urgent work is higher; deferred/icebox/nice-to-have is lower).",
    "",
    "Return ONLY a fenced ```json block of the form:",
    "```json",
    '{ "tasks": [ { "id": "<issue id>", "priority": "high|med|low", "blockedBy": ["<issue id>", ...] } ] }',
    "```",
    "Omit an issue entirely if you have no signal for it. Omit `blockedBy` when there are no edges.",
    "",
    "Issues:",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** Coerce a model id/number to the string task id it must match in the adopted set. */
function coerceId(v: string | number | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/^#/, "");
  return s.length > 0 ? s : null;
}

export interface ImportEnrichmentDeps {
  db: Db;
}

export interface ImportEnrichmentOptions {
  /** Test seam: replace the real `claude --print` invocation. */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  budgetSeconds?: number;
}

export async function runImportEnrichment(
  deps: ImportEnrichmentDeps,
  project: TaskTarget & { id?: string; agent?: string | null },
  adoptedIds: string[],
  opts: ImportEnrichmentOptions = {},
): Promise<ImportEnrichmentResult> {
  const empty: ImportEnrichmentResult = {
    edgesApplied: 0,
    prioritiesApplied: 0,
    inferenceFailed: false,
  };
  // Read the adopted issues' title + body (ImportCandidate carries no body).
  const tasks: TaskFile[] = [];
  for (const id of adoptedIds) {
    const t = await readTaskFile(project, id).catch(() => null);
    if (t) tasks.push(t);
  }
  if (tasks.length === 0) return empty;

  const prompt = buildPrompt(tasks);
  let text: string;
  try {
    const result = opts.agentInvoker
      ? await opts.agentInvoker(prompt)
      : await invokeClaudeJson(prompt, {
          agent: resolveAgent(deps.db, { projectAgent: project.agent ?? null }),
          budgetSeconds: opts.budgetSeconds ?? getAgentBudgetSeconds(),
        });
    text = result.text;
  } catch (err) {
    console.error(`[import-enrich] inference call failed: ${errMsg(err)}`);
    return { ...empty, inferenceFailed: true };
  }

  let parsed: { tasks?: InferredTask[] };
  try {
    parsed = extractJsonObject<{ tasks?: InferredTask[] }>(text);
  } catch (err) {
    console.error(`[import-enrich] no parseable JSON: ${errMsg(err)}`);
    return { ...empty, inferenceFailed: true };
  }

  const adopted = new Set(tasks.map((t) => t.id));
  const rows = Array.isArray(parsed.tasks) ? parsed.tasks : [];

  // --- Apply priorities (scoped to the adopted set) ------------------------
  let prioritiesApplied = 0;
  for (const row of rows) {
    const id = coerceId(row.id ?? row.number);
    if (!id || !adopted.has(id)) continue;
    const p = typeof row.priority === "string" ? row.priority.trim().toLowerCase() : "";
    if (!PRIORITIES.has(p as NonNullable<TaskFrontmatter["priority"]>)) continue;
    const updated = await updateTaskPriority(project, id, p as TaskFrontmatter["priority"]).catch(
      () => null,
    );
    if (updated) prioritiesApplied += 1;
  }

  // --- Apply blockedBy edges (scoped, cycle-safe, incremental) -------------
  // Mirror applyDependsOnEdges but keyed on real issue ids: build a byId clone
  // so cycle checks see edges we've already applied this pass.
  const byId = tasksById(tasks.map((t) => ({ ...t, frontmatter: { ...t.frontmatter } })));
  let edgesApplied = 0;
  for (const row of rows) {
    const id = coerceId(row.id ?? row.number);
    if (!id || !adopted.has(id)) continue;
    const raw = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    const depIds = normalizeBlockedBy(
      raw.map(coerceId).filter((d): d is string => d != null && adopted.has(d)),
      id,
    );
    if (depIds.length === 0) continue;
    if (dependencyCycleExists(byId, id, depIds)) {
      console.warn(`[import-enrich] skipped cyclic inferred edges for ${id}`);
      continue;
    }
    const node = byId.get(id);
    if (node) node.frontmatter.blockedBy = depIds;
    const updated = await updateTaskBlockedBy(project, id, depIds).catch(() => null);
    if (updated) edgesApplied += 1;
  }

  return { edgesApplied, prioritiesApplied, inferenceFailed: false };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface OrganizeBacklogResult extends ImportEnrichmentResult {
  /** Open tasks fed to inference (non-terminal). */
  taskCount: number;
}

/**
 * Re-runnable "organize backlog": run import-style inference over a project's
 * CURRENT open tasks (not just a fresh import) — inferring `blockedBy` edges +
 * `priority` from each task's body and applying them. Operator-triggered; lets
 * an already-adopted or hand-built backlog be organized in place. Same safety as
 * `runImportEnrichment` (scoped, cycle-safe, best-effort). Terminal tasks
 * (done/dropped) are excluded.
 */
export async function organizeProjectBacklog(
  deps: ImportEnrichmentDeps,
  project: TaskTarget & { id?: string; agent?: string | null },
  opts: ImportEnrichmentOptions = {},
): Promise<OrganizeBacklogResult> {
  const tasks = await listTasks(project);
  const ids = tasks.filter((t) => !TERMINAL_STATUSES.has(t.frontmatter.status)).map((t) => t.id);
  const result = await runImportEnrichment(deps, project, ids, opts);
  return { ...result, taskCount: ids.length };
}
