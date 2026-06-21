import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

/**
 * A project-local skill discovered at `<project>/.claude/skills/<name>/SKILL.md`.
 *
 * Skills are repo-canonical: they live in the project repo and Factory only
 * indexes them at query time (mirrors `audit-skills.ts`). Execution is
 * harness-agnostic — Factory does not run skills itself; it surfaces what the
 * project ships so the operator can see which skills a run's agent can reach.
 */
export interface ProjectSkill {
  /** Skill identifier — frontmatter `name`, falling back to the directory name. */
  name: string;
  /** One-line summary from frontmatter `description` (empty when absent). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse a skill's `name` + `description` from its SKILL.md frontmatter.
 * Returns null when the file has no parseable YAML frontmatter block.
 */
export function parseProjectSkill(
  raw: string,
  filePath: string,
  fallbackName: string,
): ProjectSkill | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const obj = YAML.parse(m[1] ?? "") as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  return {
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name : fallbackName,
    description: typeof obj.description === "string" ? obj.description : "",
    filePath,
  };
}

/**
 * List Claude Code skills installed in `<project>/.claude/skills/<name>/SKILL.md`.
 *
 * Single point of truth for project-skill discovery (mirrors `listAuditSkills`).
 * Projects with no `.claude/skills/` directory — or no SKILL.md files within it —
 * return an empty list without throwing. Directories whose SKILL.md is missing or
 * has malformed frontmatter are skipped (logged via console.warn so the operator
 * notices).
 */
export async function listProjectSkills(projectPath: string): Promise<ProjectSkill[]> {
  const dir = path.join(projectPath, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: ProjectSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const raw = await readFile(skillFile, "utf8");
      const skill = parseProjectSkill(raw, skillFile, entry.name);
      if (skill) skills.push(skill);
      else console.warn(`[project-skills] malformed frontmatter: ${skillFile}`);
    } catch (err) {
      console.warn(
        `[project-skills] failed to read ${skillFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Resolve a single project skill by its `name` (frontmatter name, falling back
 * to directory name — the same identity `listProjectSkills` reports). Returns
 * null when the project ships no skill under that name. Mirrors
 * `readAuditSkill`; used by `skills.submit` to validate a requested skill
 * before spawning a run for it.
 */
export async function findProjectSkill(
  projectPath: string,
  skillName: string,
): Promise<ProjectSkill | null> {
  const skills = await listProjectSkills(projectPath);
  return skills.find((s) => s.name === skillName) ?? null;
}
