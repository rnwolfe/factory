import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";

/**
 * The operator-memory store (ADR-010 §4) — a fresh, Factory-owned git repo of the
 * operator's conventions/preferences/patterns, in Claude-Code memory format
 * (`MEMORY.md` index + one frontmatter-markdown file per fact). This is the single
 * IO seam: ensure the repo, write a fact (operator-gated, one commit), and read it
 * back for the PWA viewer / run-context injection. Swappable to a remote later.
 *
 * Fresh by default *on purpose*: it synthesizes new knowledge and is promoted into,
 * not a mirror of any harness's existing memory.
 */

export type MemoryFactType = "user" | "feedback" | "project" | "reference";
const FACT_TYPES: readonly MemoryFactType[] = ["user", "feedback", "project", "reference"];

export interface MemoryFactInput {
  /** Kebab-case slug; also the filename stem. Derive with {@link slugify}. */
  name: string;
  description: string;
  type: MemoryFactType;
  body: string;
  /** Free-form provenance lines (e.g. "watch:<observationId>"). */
  provenance?: string[];
}

export interface MemoryFact extends MemoryFactInput {
  /** Repo-relative file (e.g. "scaffolds-clis-by-hand.md"). */
  file: string;
}

const HEADER = `# Operator memory

Factory-earned memory of the operator's conventions, preferences, and patterns —
synthesized from observed work and promoted from inbox insights. Claude-Code
memory format: this index plus one frontmatter-markdown file per fact.
`;

export function defaultOperatorMemoryPath(factoryHome: string): string {
  return path.join(factoryHome, "operator-memory");
}

/** Slugify a title into a stable kebab-case fact name. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "fact"
  );
}

async function git(repoPath: string, args: string[]): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", "-C", repoPath, ...args],
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Create + git-init the repo on first use (idempotent). */
export async function ensureMemoryRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  if (await isDir(path.join(repoPath, ".git"))) return;
  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["config", "user.name", "Factory"]);
  await git(repoPath, ["config", "user.email", "factory@localhost"]);
  await writeFile(path.join(repoPath, "MEMORY.md"), HEADER, "utf8");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-q", "-m", "init operator-memory"]);
}

/**
 * Write (or overwrite) a fact and commit it. The MEMORY.md index is rebuilt from
 * the facts on disk so it never drifts. Operator-gated by the caller — this just
 * does the IO.
 */
export async function writeMemoryFact(repoPath: string, fact: MemoryFactInput): Promise<void> {
  await ensureMemoryRepo(repoPath);
  const file = `${fact.name}.md`;
  await writeFile(path.join(repoPath, file), renderFact(fact), "utf8");
  await rebuildIndex(repoPath);
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-q", "-m", `memory: ${fact.name}`]);
}

function renderFact(fact: MemoryFactInput): string {
  const lines = [
    "---",
    `name: ${fact.name}`,
    `description: ${fact.description.replace(/\s+/g, " ").trim()}`,
    `type: ${fact.type}`,
  ];
  if (fact.provenance?.length) lines.push(`provenance: ${fact.provenance.join(", ")}`);
  lines.push("---", "", fact.body.trim(), "");
  return lines.join("\n");
}

/** Read every fact (MEMORY.md excluded). Skips unparseable files defensively. */
export async function listMemoryFacts(repoPath: string): Promise<MemoryFact[]> {
  let files: string[] = [];
  try {
    files = await readdir(repoPath);
  } catch {
    return [];
  }
  const facts: MemoryFact[] = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    let raw: string;
    try {
      raw = await readFile(path.join(repoPath, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseFact(raw, file);
    if (parsed) facts.push(parsed);
  }
  facts.sort((a, b) => a.name.localeCompare(b.name));
  return facts;
}

/**
 * A reading-list POINTER to the operator-memory repo, for run prompts (ADR-010
 * §4). Returns "" when the repo has no facts — a run only learns about the memory
 * once there's something worth reading. This is deliberately a *pointer*, not a
 * doctrine prepend: it tells the agent where the operator's recorded conventions
 * live (a machine-local path it can read directly) and lets it decide to consult
 * them, consistent with the "AGENTS.md is a reading list, not a magic prepend"
 * contract. The task body and any frozen plan still win on scope.
 */
export async function operatorMemoryPointer(repoPath: string): Promise<string> {
  const facts = await listMemoryFacts(repoPath);
  if (facts.length === 0) return "";
  const indexPath = path.join(repoPath, "MEMORY.md");
  return `\n\n---\n\n## Operator memory (reading list)\n\nThis operator has ${facts.length} recorded convention(s)/preference(s) — a Factory-earned memory of how they work — indexed at \`${indexPath}\` (machine-local; read it directly if relevant). Treat entries as observed preferences that inform judgment calls, **not** hard rules: the task body and any frozen plan still govern scope.\n`;
}

/** The MEMORY.md index text (for the viewer header / direct display). */
export async function readMemoryIndex(repoPath: string): Promise<string> {
  try {
    return await readFile(path.join(repoPath, "MEMORY.md"), "utf8");
  } catch {
    return "";
  }
}

function parseFact(raw: string, file: string): MemoryFact | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const front: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const name = front.name || file.replace(/\.md$/, "");
  const type = (FACT_TYPES as readonly string[]).includes(front.type ?? "")
    ? (front.type as MemoryFactType)
    : "reference";
  return {
    file,
    name,
    description: front.description ?? "",
    type,
    body: (m[2] ?? "").trim(),
    provenance: front.provenance ? front.provenance.split(",").map((s) => s.trim()) : undefined,
  };
}

async function rebuildIndex(repoPath: string): Promise<void> {
  const facts = await listMemoryFacts(repoPath);
  const byType = (t: MemoryFactType) => facts.filter((f) => f.type === t);
  const section = (label: string, t: MemoryFactType): string => {
    const rows = byType(t)
      .map((f) => `- [${f.name}](${f.file}) — ${f.description}`)
      .join("\n");
    return rows ? `\n## ${label}\n\n${rows}\n` : "";
  };
  const body =
    HEADER +
    section("User", "user") +
    section("Feedback", "feedback") +
    section("Project", "project") +
    section("Reference", "reference");
  await writeFile(path.join(repoPath, "MEMORY.md"), body, "utf8");
}
