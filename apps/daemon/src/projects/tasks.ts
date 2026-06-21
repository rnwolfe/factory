import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { GithubAppClient } from "../github/app-auth.ts";
import { parseGithubRepo } from "../github/app-auth.ts";
import { GithubIssuesStore } from "./github-task-store.ts";

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
  labels?: string[];
  estimate?: "small" | "medium" | "large";
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
  if (justFinishedId) {
    const idx = tasks.findIndex((t) => t.id === justFinishedId);
    if (idx >= 0) {
      return tasks.slice(idx + 1).find((t) => t.frontmatter.status === "ready") ?? null;
    }
  }
  return tasks.find((t) => t.frontmatter.status === "ready") ?? null;
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
 * Resolve the task store for a target. Single dispatch point — `github-issues`
 * projects get a `GithubIssuesStore`; everything else stays file-backed.
 */
export function taskStoreFor(target: TaskTarget): TaskStore {
  if (target.taskBackend === "github-issues") {
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
  }
  return new FileTaskStore(target.workdirPath);
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
  return taskStoreFor(target).create(input);
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
