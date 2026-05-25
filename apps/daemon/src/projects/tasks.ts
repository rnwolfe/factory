import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

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

export async function listTasks(projectPath: string): Promise<TaskFile[]> {
  const dir = path.join(projectPath, ".factory", "work");
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

export async function readTaskFile(projectPath: string, taskId: string): Promise<TaskFile | null> {
  const all = await listTasks(projectPath);
  return all.find((t) => t.id === taskId) ?? null;
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

export async function updateTaskStatus(
  projectPath: string,
  taskId: string,
  status: TaskFrontmatter["status"],
): Promise<TaskFile | null> {
  const t = await readTaskFile(projectPath, taskId);
  if (!t) return null;
  const updated: TaskFile = {
    ...t,
    frontmatter: {
      ...t.frontmatter,
      status,
      updated: new Date().toISOString(),
    },
  };
  await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
  return updated;
}

/**
 * Set or clear the per-task model override. Empty string clears the field
 * entirely (falls back to project default at submit time); a non-empty
 * value pins the task to that model id.
 */
export async function updateTaskModel(
  projectPath: string,
  taskId: string,
  model: string,
): Promise<TaskFile | null> {
  const t = await readTaskFile(projectPath, taskId);
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

export async function updateTaskBody(
  projectPath: string,
  taskId: string,
  body: string,
): Promise<TaskFile | null> {
  const t = await readTaskFile(projectPath, taskId);
  if (!t) return null;
  const updated: TaskFile = {
    ...t,
    body,
    frontmatter: {
      ...t.frontmatter,
      updated: new Date().toISOString(),
    },
  };
  await writeFile(t.filePath, renderTaskMarkdown(updated), "utf8");
  return updated;
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
}

/**
 * Single-point-of-truth for task creation. Picks the next monotonic task id,
 * writes the file under `.factory/work/`, returns the parsed result. All
 * task-creation flows route through this — bootstrap, refinement freeze,
 * feature_plan freeze, audit-finding promotion, ad-hoc PWA "+ task".
 *
 * Storage swap (GitHub Issues, beads, etc.) is a one-file change here.
 */
export async function createTask(projectPath: string, input: CreateTaskInput): Promise<TaskFile> {
  const dir = path.join(projectPath, ".factory", "work");
  if (!existsSync(dir)) {
    throw new Error(`project task directory does not exist: ${dir}`);
  }
  const existing = await listTasks(projectPath);
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
  const file: TaskFile = { id, filePath, frontmatter, body: input.body };
  await writeFile(filePath, renderTaskMarkdown(file), "utf8");
  return file;
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
