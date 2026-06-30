import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { GithubAppClient } from "../github/app-auth.ts";
import { parseGithubRepo } from "../github/app-auth.ts";
import {
  GithubIssuesStore,
  type IssueComment,
  type IssueConversation,
} from "./github-task-store.ts";

export interface TaskFile {
  id: string;
  filePath: string;
  frontmatter: TaskFrontmatter;
  body: string;
}

export interface TaskFrontmatter {
  id: string;
  title: string;
  status: "ready" | "in_progress" | "review" | "done" | "blocked" | "dropped";
  priority?: "low" | "med" | "high";
  created?: string;
  updated?: string;
  parent?: string;
  /**
   * Task dependency edges (ADR-019): the ids of tasks this one is *blocked by*.
   * Many-to-many; the inverse (`blocks`) is derived, never stored. A task is
   * startable only once every `blockedBy` dep is `done`/`dropped`. Maps onto
   * GitHub's native issue-dependency relation on the GitHub-Issues backend.
   * Default/absent = no edges = parallel (today's behavior).
   */
  blockedBy?: string[];
  labels?: string[];
  estimate?: "small" | "medium" | "large";
  /**
   * The spec milestone this task belongs to (e.g. `"M1"`), when the project was
   * built from a milestone-structured spec. Set by spec-import (first batch) and
   * by milestone decomposition. Drives "which milestone is next/active/done"
   * (derived from tasks, not a separate roadmap entity). See ADR-009.
   */
  milestone?: string;
  /** Provenance: the milestone whose decomposition created this task. */
  sourceMilestone?: string;
  /**
   * Per-task Claude model override. When set, this beats the project model
   * default during submit. Use it to pin a heavy task to Opus or a busywork
   * task to Haiku without changing the project-wide default.
   */
  model?: string;
  /**
   * Per-task agent harness override. Currently `claude-code` (default) or
   * `codex`. Selects which provider drives the code-changing run; the model
   * string in `model` is interpreted by the chosen provider.
   */
  agent?: string;
  [k: string]: unknown;
}

export type TaskBackend = "file" | "github-issues";

/**
 * The minimum a caller must supply to resolve a task store. The full project
 * row satisfies this structurally (it carries `workdirPath`, `taskBackend`,
 * `githubRemote`, `githubInstallationId`). Callers that don't have a row yet
 * (bootstrap, the run worktree) pass a literal `{ workdirPath }` — backend
 * defaults to `file`.
 */
export interface TaskTarget {
  workdirPath: string;
  taskBackend?: TaskBackend | null;
  githubRemote?: string | null;
  githubInstallationId?: number | null;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseTaskMarkdown(filePath: string, raw: string): TaskFile | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const frontmatter = YAML.parse(m[1] ?? "") as TaskFrontmatter | null;
  if (!frontmatter || typeof frontmatter.id !== "string") return null;
  return {
    id: frontmatter.id,
    filePath,
    frontmatter,
    body: m[2] ?? "",
  };
}

export function renderTaskMarkdown(t: TaskFile): string {
  const fm = YAML.stringify(t.frontmatter).trimEnd();
  return `---\n${fm}\n---\n\n${t.body.replace(/^\s+/, "")}\n`;
}

/**
 * Pick the next ready task after the one we just finished.
 *
 * Tasks are sorted by id (numeric collation). When `justFinishedId` is
 * given, we only consider tasks AFTER it — auto-advance must not wrap
 * back to earlier tasks. If the operator started at task-009, they
 * intended to skip 001-008; quietly re-running 001 after 009 finishes
 * silently undoes that intent. When no later task is ready, auto-advance
 * stops and the operator can pick an earlier one manually.
 *
 * When `justFinishedId` is null/unknown, falls back to the first ready
 * task in the list — the original behavior for ad-hoc submissions
 * without a recorded task id.
 */
export function pickNextReadyTask(
  tasks: TaskFile[],
  justFinishedId: string | null | undefined,
): TaskFile | null {
  // Respect dependency edges: a task whose `blockedBy` deps aren't all done is
  // ready-but-gated, not startable (ADR-019). The whole pool is needed to resolve
  // dep statuses, so build the index once.
  const byId = tasksById(tasks);
  if (justFinishedId) {
    const idx = tasks.findIndex((t) => t.id === justFinishedId);
    if (idx >= 0) {
      return tasks.slice(idx + 1).find((t) => isStartable(t, byId)) ?? null;
    }
  }
  return tasks.find((t) => isStartable(t, byId)) ?? null;
}

// --- Task dependencies (ADR-019) ------------------------------------------

/** A dependency is satisfied once the upstream task is terminal. */
const DEP_SATISFIED = new Set<TaskFrontmatter["status"]>(["done", "dropped"]);
/** Matches GitHub's per-relationship ceiling; also bounds the cycle/scan cost. */
export const MAX_BLOCKED_BY = 50;

/** Index a task list by id for O(1) dependency lookups. */
export function tasksById(tasks: TaskFile[]): Map<string, TaskFile> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/**
 * Clean a caller-supplied `blockedBy` list: trim, drop empties + self, dedupe,
 * cap. Applied centrally at the `createTask` seam and the edit mutation so every
 * creation point handles dependencies identically — no caller can persist a
 * malformed edge set.
 */
export function normalizeBlockedBy(ids: string[] | undefined | null, selfId?: string): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_BLOCKED_BY) break;
  }
  return out;
}

/**
 * A task is startable iff it is `ready` AND every `blockedBy` dependency is
 * terminal (`done`/`dropped`). An unknown dep id is treated as satisfied (a
 * stale edge must never deadlock the pool). The blocked-by-an-open-dep state is
 * derived here, never stored — so a dependency completing makes its dependents
 * startable with no status write.
 */
export function isStartable(task: TaskFile, byId: Map<string, TaskFile>): boolean {
  if (task.frontmatter.status !== "ready") return false;
  const deps = task.frontmatter.blockedBy ?? [];
  for (const id of deps) {
    const dep = byId.get(id);
    if (dep && !DEP_SATISFIED.has(dep.frontmatter.status)) return false;
  }
  return true;
}

/** The open (non-terminal) subset of a task's dependencies — for UI ("waiting on …"). */
export function openBlockers(task: TaskFile, byId: Map<string, TaskFile>): string[] {
  return (task.frontmatter.blockedBy ?? []).filter((id) => {
    const dep = byId.get(id);
    return dep ? !DEP_SATISFIED.has(dep.frontmatter.status) : false;
  });
}

/**
 * Would setting `taskId.blockedBy = proposedDeps` introduce a cycle? Walks the
 * existing `blockedBy` graph from each proposed dep; a path back to `taskId`
 * means the edge closes a loop (and would deadlock the gate). Used by the edit
 * mutation before persisting.
 */
export function dependencyCycleExists(
  byId: Map<string, TaskFile>,
  taskId: string,
  proposedDeps: string[],
): boolean {
  const seen = new Set<string>();
  const stack = [...proposedDeps];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const dep = byId.get(cur);
    if (dep) stack.push(...(dep.frontmatter.blockedBy ?? []));
  }
  return false;
}

/**
 * Coerce a model-emitted `dependsOn` into clean, draft-local task indices
 * (non-negative integers). Used by every decomposition coercer so a draft can
 * carry intra-batch ordering. Absent/empty → undefined (parallel — the default).
 */
export function coerceDependsOnIndices(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0,
  );
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve a decomposition's intra-batch `dependsOn` (draft-local indices) into
 * real `blockedBy` edges, after the batch's tasks have been created (ADR-019 §5).
 * Two-pass — tasks have no ids until created — so freeze paths create everything
 * first, then call this with `created` in draft order and the parallel
 * `dependsOn` arrays. Cyclic edge sets are skipped (logged), never persisted.
 * A draft with no `dependsOn` anywhere is a no-op (parallel-by-default).
 */
export async function applyDependsOnEdges(
  target: TaskTarget,
  created: TaskFile[],
  dependsOn: Array<number[] | undefined>,
): Promise<void> {
  const idByIndex = created.map((t) => t.id);
  // Clone frontmatter so incremental cycle tracking doesn't mutate the caller's tasks.
  const byId = tasksById(created.map((t) => ({ ...t, frontmatter: { ...t.frontmatter } })));
  for (let i = 0; i < created.length; i += 1) {
    const deps = dependsOn[i];
    if (!deps || deps.length === 0) continue;
    const depIds = normalizeBlockedBy(
      deps.map((idx) => idByIndex[idx]).filter((x): x is string => typeof x === "string"),
      created[i]?.id,
    );
    if (depIds.length === 0) continue;
    const selfId = created[i]?.id;
    if (!selfId) continue;
    if (dependencyCycleExists(byId, selfId, depIds)) {
      console.warn(`[deps] skipped cyclic dependsOn for ${selfId}`);
      continue;
    }
    const node = byId.get(selfId);
    if (node) node.frontmatter.blockedBy = depIds;
    await updateTaskBlockedBy(target, selfId, depIds);
  }
}

export interface CreateTaskInput {
  title: string;
  /** Full markdown body. Caller controls section structure. */
  body: string;
  status?: TaskFrontmatter["status"];
  priority?: TaskFrontmatter["priority"];
  estimate?: TaskFrontmatter["estimate"];
  labels?: string[];
  parent?: string;
  /** Task ids this task is blocked by (ADR-019). Normalized at the createTask seam. */
  blockedBy?: string[];
  /** Spec milestone this task belongs to (e.g. `"M1"`). See ADR-009. */
  milestone?: string;
  /** Provenance: the milestone whose decomposition created this task. */
  sourceMilestone?: string;
  /** Per-task model override. Falls through to project/system default when omitted. */
  model?: string;
  /**
   * Per-task agent override (`claude-code` | `codex`). Falls through to the
   * project/system default when omitted. Persisted into the task's
   * frontmatter so it survives across runs that target the task.
   */
  agent?: string;
  /** Structured provenance for tasks emitted from plans/finding promotion. */
  sourcePlanId?: string;
  sourceAuditId?: string;
  sourceFindingIds?: string[];
  /**
   * The agent_decision this task was resurfaced from (operator override).
   * Carried as task provenance so the re-queued work links back to the
   * originating decision for the audit trail — see `decisions/resurface.ts`.
   */
  sourceDecisionId?: string;
}

/**
 * The storage seam. One backend reads/writes `.factory/work/*.md`; the
 * GitHub-Issues backend (ADR-007 Phase 2) reads/writes issues. All task IO
 * routes through a `TaskStore` so the backend is a per-project choice and not
 * a concern of any caller.
 */
export interface TaskStore {
  list(): Promise<TaskFile[]>;
  read(id: string): Promise<TaskFile | null>;
  create(input: CreateTaskInput): Promise<TaskFile>;
  updateStatus(id: string, status: TaskFrontmatter["status"]): Promise<TaskFile | null>;
  updateModel(id: string, model: string): Promise<TaskFile | null>;
  updateAgent(id: string, agent: string): Promise<TaskFile | null>;
  updateBody(id: string, body: string): Promise<TaskFile | null>;
  /** Replace the task's `blockedBy` dependency edges (ADR-019). Empty clears them. */
  updateBlockedBy(id: string, blockedBy: string[]): Promise<TaskFile | null>;

  // --- Remote-discussion / adoption ops. ---------------------------------
  // The issue-backed backend implements these against the GitHub issue's
  // comment thread; file-backed projects have no remote thread and implement
  // them as no-ops. Dispatch lives in the store so no caller branches on the
  // backend (the standalone facades below are thin wrappers over these).
  /** The task's remote comment thread (chronological). `[]` when none. */
  listComments(taskId: string): Promise<IssueComment[]>;
  /** Post a machine comment to the task's remote thread. */
  postComment(taskId: string, body: string): Promise<void>;
  /** Add a reaction (e.g. `eyes`) to a remote comment by its id. */
  reactToComment(commentId: number, content: string): Promise<void>;
  /** Adopt an externally-authored remote issue as a Factory task. */
  adopt(taskId: string): Promise<TaskFile | null>;
  /** Render the remote thread as a delimited Discussion prompt block. */
  fetchDiscussion(taskId: string): Promise<string>;
  /** Fetch title/body + rendered thread for a conversational reply. */
  fetchConversation(taskId: string): Promise<IssueConversation | null>;
  /** Post to the remote thread as the OPERATOR (their PAT), not the bot. */
  replyAsOperator(token: string, taskId: string, body: string): Promise<void>;
}

/**
 * Local markdown-with-frontmatter store: tasks live as
 * `<workdir>/.factory/work/<id>-<slug>.md`. This is the default and the only
 * backend for `tinker`/local projects.
 */
export class FileTaskStore implements TaskStore {
  constructor(private readonly projectPath: string) {}

  private dir(): string {
    return path.join(this.projectPath, ".factory", "work");
  }

  async list(): Promise<TaskFile[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    const tasks: TaskFile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = parseTaskMarkdown(filePath, raw);
        if (parsed) tasks.push(parsed);
      } catch {
        // skip unreadable files
      }
    }
    // Sort by id (which is monotonic per the spec).
    tasks.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    return tasks;
  }

  async read(taskId: string): Promise<TaskFile | null> {
    const all = await this.list();
    return all.find((t) => t.id === taskId) ?? null;
  }

  async updateStatus(taskId: string, status: TaskFrontmatter["status"]): Promise<TaskFile | null> {
    const t = await this.read(taskId);
    if (!t) return null;
    const updated: TaskFile = {
      ...t,
      frontmatter: { ...t.frontmatter, status, updated: new Date().toISOString() },
    };
    await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
    return updated;
  }

  /**
   * Set or clear the per-task model override. Empty string clears the field
   * entirely (falls back to project default at submit time); a non-empty
   * value pins the task to that model id.
   */
  async updateModel(taskId: string, model: string): Promise<TaskFile | null> {
    const t = await this.read(taskId);
    if (!t) return null;
    const trimmed = model.trim();
    const nextFrontmatter: TaskFrontmatter = {
      ...t.frontmatter,
      updated: new Date().toISOString(),
    };
    if (trimmed.length > 0) {
      nextFrontmatter.model = trimmed;
    } else {
      delete nextFrontmatter.model;
    }
    const updated: TaskFile = { ...t, frontmatter: nextFrontmatter };
    await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
    return updated;
  }

  /**
   * Set or clear the per-task agent override. Empty string clears the field
   * entirely (falls back to project default at submit time); a non-empty
   * value pins the task to that agent id.
   */
  async updateAgent(taskId: string, agent: string): Promise<TaskFile | null> {
    const t = await this.read(taskId);
    if (!t) return null;
    const trimmed = agent.trim();
    const nextFrontmatter: TaskFrontmatter = {
      ...t.frontmatter,
      updated: new Date().toISOString(),
    };
    if (trimmed.length > 0) {
      nextFrontmatter.agent = trimmed;
    } else {
      delete nextFrontmatter.agent;
    }
    const updated: TaskFile = { ...t, frontmatter: nextFrontmatter };
    await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
    return updated;
  }

  async updateBlockedBy(taskId: string, blockedBy: string[]): Promise<TaskFile | null> {
    const t = await this.read(taskId);
    if (!t) return null;
    const next = normalizeBlockedBy(blockedBy, taskId);
    const nextFrontmatter: TaskFrontmatter = {
      ...t.frontmatter,
      updated: new Date().toISOString(),
    };
    if (next.length > 0) nextFrontmatter.blockedBy = next;
    else delete nextFrontmatter.blockedBy;
    const updated: TaskFile = { ...t, frontmatter: nextFrontmatter };
    await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
    return updated;
  }

  async updateBody(taskId: string, body: string): Promise<TaskFile | null> {
    const t = await this.read(taskId);
    if (!t) return null;
    const updated: TaskFile = {
      ...t,
      body,
      frontmatter: { ...t.frontmatter, updated: new Date().toISOString() },
    };
    await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
    return updated;
  }

  async create(input: CreateTaskInput): Promise<TaskFile> {
    const dir = this.dir();
    if (!existsSync(dir)) {
      throw new Error(`project task directory does not exist: ${dir}`);
    }
    const existing = await this.list();
    const id = nextTaskId(existing);
    const fileName = `${id}-${slugify(input.title || "task").slice(0, 40)}.md`;
    const filePath = path.join(dir, fileName);
    const now = new Date().toISOString();
    const frontmatter: TaskFrontmatter = {
      id,
      title: input.title || "Untitled",
      status: input.status ?? "ready",
      priority: input.priority ?? "med",
      estimate: input.estimate ?? "small",
      created: now,
      updated: now,
    };
    if (input.labels && input.labels.length > 0) frontmatter.labels = input.labels;
    if (input.parent) frontmatter.parent = input.parent;
    if (input.blockedBy && input.blockedBy.length > 0) frontmatter.blockedBy = input.blockedBy;
    if (input.milestone && input.milestone.trim().length > 0) {
      frontmatter.milestone = input.milestone.trim();
    }
    if (input.sourceMilestone && input.sourceMilestone.trim().length > 0) {
      frontmatter.sourceMilestone = input.sourceMilestone.trim();
    }
    if (input.model && input.model.trim().length > 0) frontmatter.model = input.model.trim();
    if (input.agent && input.agent.trim().length > 0) frontmatter.agent = input.agent.trim();
    if (input.sourcePlanId && input.sourcePlanId.trim().length > 0) {
      frontmatter.sourcePlanId = input.sourcePlanId.trim();
    }
    if (input.sourceAuditId && input.sourceAuditId.trim().length > 0) {
      frontmatter.sourceAuditId = input.sourceAuditId.trim();
    }
    if (input.sourceFindingIds && input.sourceFindingIds.length > 0) {
      frontmatter.sourceFindingIds = input.sourceFindingIds.filter((id) => id.trim().length > 0);
    }
    if (input.sourceDecisionId && input.sourceDecisionId.trim().length > 0) {
      frontmatter.sourceDecisionId = input.sourceDecisionId.trim();
    }
    const file: TaskFile = { id, filePath, frontmatter, body: input.body };
    await writeFile(filePath, renderTaskMarkdown(file), "utf8");
    return file;
  }

  // --- Remote-discussion ops: file-backed tasks have no remote thread. -----
  /** No remote thread → empty. */
  async listComments(): Promise<IssueComment[]> {
    return [];
  }

  /** No remote thread → unsupported; best-effort callers swallow the throw as "not posted". */
  async postComment(): Promise<void> {
    throw new Error("file-backed tasks have no remote comment thread");
  }

  /** No remote thread → unsupported (see postComment). */
  async reactToComment(): Promise<void> {
    throw new Error("file-backed tasks have no remote comment thread");
  }

  /** File tasks aren't adopted from a remote issue → nothing to adopt. */
  async adopt(): Promise<TaskFile | null> {
    return null;
  }

  /** No remote thread → empty discussion block. */
  async fetchDiscussion(): Promise<string> {
    return "";
  }

  /** No remote issue → no conversation. */
  async fetchConversation(): Promise<IssueConversation | null> {
    return null;
  }

  /** No remote issue → operator replies are unsupported. */
  async replyAsOperator(): Promise<void> {
    throw new Error("file-backed tasks have no remote issue to reply to");
  }
}

let sharedGithubClient: GithubAppClient | null = null;

/**
 * Wire the GitHub App client used by `github-issues`-backed projects. Called
 * once at daemon boot from the resolved config; null leaves the backend
 * unconfigured (projects opted into github-issues then error clearly rather
 * than silently reading an empty local `.factory/work`).
 */
export function configureGithubTaskBackend(client: GithubAppClient | null): void {
  sharedGithubClient = client;
}

/**
 * A backend factory: given a resolution target, build its `TaskStore`. Adding a
 * backend is a new `TaskStore` impl + one `registerBackend` call — no caller and
 * no dispatch site changes (ADR-015).
 */
export type TaskStoreFactory = (target: TaskTarget) => TaskStore;

const backendRegistry = new Map<TaskBackend, TaskStoreFactory>();

/** Register (or override) the store factory for a task backend. */
export function registerBackend(backend: TaskBackend, factory: TaskStoreFactory): void {
  backendRegistry.set(backend, factory);
}

// Built-in backends. The file backend is the default and the fallback.
registerBackend("file", (target) => new FileTaskStore(target.workdirPath));
registerBackend("github-issues", (target) => {
  if (!sharedGithubClient) {
    throw new Error(
      "project uses the github-issues task backend but the Factory App is not configured",
    );
  }
  const repo = target.githubRemote ? parseGithubRepo(target.githubRemote) : null;
  if (!repo) {
    throw new Error("github-issues task backend requires a parseable github remote");
  }
  return new GithubIssuesStore(
    sharedGithubClient,
    repo.owner,
    repo.repo,
    target.githubInstallationId ?? null,
  );
});

/**
 * Resolve the task store for a target. Single dispatch point — looks the backend
 * up in the registry (defaulting to `file`) rather than branching inline, so a
 * new backend never touches this function.
 */
export function taskStoreFor(target: TaskTarget): TaskStore {
  const factory = backendRegistry.get(target.taskBackend ?? "file") ?? backendRegistry.get("file");
  if (!factory) {
    throw new Error("no task backend registered (file backend missing)");
  }
  return factory(target);
}

// --- Free-function facade -------------------------------------------------
// Names preserved for call-site stability; each delegates to the resolved
// store. Single-point-of-truth for task IO — a storage swap is a change to
// `taskStoreFor` + a new TaskStore implementation, not to any caller.

export function listTasks(target: TaskTarget): Promise<TaskFile[]> {
  return taskStoreFor(target).list();
}

export function readTaskFile(target: TaskTarget, taskId: string): Promise<TaskFile | null> {
  return taskStoreFor(target).read(taskId);
}

export function createTask(target: TaskTarget, input: CreateTaskInput): Promise<TaskFile> {
  // The single creation seam normalizes EVERY task the same way, so no caller can
  // diverge: (1) guarantee an `## Acceptance` section so the verifier's acceptance
  // signal is never permanently absent (which would hold autonomous runs); (2)
  // clean the `blockedBy` dependency edges (ADR-019) — trim/dedupe/cap.
  return taskStoreFor(target).create({
    ...input,
    body: ensureAcceptanceSection(input.body),
    blockedBy: normalizeBlockedBy(input.blockedBy),
  });
}

/** Set/replace a task's dependency edges. Normalized; rejects self + cycles upstream. */
export function updateTaskBlockedBy(
  target: TaskTarget,
  taskId: string,
  blockedBy: string[],
): Promise<TaskFile | null> {
  return taskStoreFor(target).updateBlockedBy(taskId, normalizeBlockedBy(blockedBy, taskId));
}

export function updateTaskStatus(
  target: TaskTarget,
  taskId: string,
  status: TaskFrontmatter["status"],
): Promise<TaskFile | null> {
  return taskStoreFor(target).updateStatus(taskId, status);
}

export function updateTaskModel(
  target: TaskTarget,
  taskId: string,
  model: string,
): Promise<TaskFile | null> {
  return taskStoreFor(target).updateModel(taskId, model);
}

export function updateTaskAgent(
  target: TaskTarget,
  taskId: string,
  agent: string,
): Promise<TaskFile | null> {
  return taskStoreFor(target).updateAgent(taskId, agent);
}

export function updateTaskBody(
  target: TaskTarget,
  taskId: string,
  body: string,
): Promise<TaskFile | null> {
  return taskStoreFor(target).updateBody(taskId, body);
}

function nextTaskId(existing: TaskFile[]): string {
  let max = 0;
  for (const t of existing) {
    const m = /^task-(\d+)$/.exec(t.id);
    if (m) {
      const n = Number.parseInt(m[1] ?? "0", 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Helper for callers building "## Acceptance" sections. Returns a checkbox list
 * with a "(TBD)" fallback when the input is empty.
 */
export function renderAcceptanceBlock(criteria: string[] | undefined | null): string {
  if (!criteria || criteria.length === 0) return "- [ ] (TBD)";
  return criteria.map((c) => `- [ ] ${c}`).join("\n");
}

/**
 * Guarantee a task body carries an `## Acceptance` section. The verifier's
 * acceptance signal is read against this section (the completion footer asks the
 * agent to report acceptance against the task's own `## Acceptance`); a task
 * created without it leaves that signal permanently *absent*, so autonomous runs
 * are held forever. Plan-freeze paths already emit the heading; promote paths
 * (audit-finding → task, watch-insight adopt-as-task, release-proposal) did not.
 * Applying this at the single `createTask` seam means no caller can omit it.
 * Idempotent: a body that already has an Acceptance heading is returned as-is.
 */
export function ensureAcceptanceSection(body: string | undefined | null): string {
  const b = (body ?? "").replace(/\s+$/, "");
  if (/^#{1,6}\s+acceptance\b/im.test(b)) return body ?? "";
  const lead = b.length > 0 ? `${b}\n\n` : "";
  return `${lead}## Acceptance\n\n${renderAcceptanceBlock(null)}\n`;
}
