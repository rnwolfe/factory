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
