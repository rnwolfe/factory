import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditSkillFrontmatter } from "@factory/db";
import YAML from "yaml";

export interface AuditSkillFile {
  name: string;
  filePath: string;
  frontmatter: AuditSkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string, name: string): AuditSkillFrontmatter | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const obj = YAML.parse(m[1] ?? "") as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  const kind = obj.kind === "exec" ? "exec" : "read-only";
  return {
    name: typeof obj.name === "string" ? obj.name : name,
    description: typeof obj.description === "string" ? obj.description : "",
    kind,
    needsWorktree:
      typeof obj.needs_worktree === "boolean"
        ? obj.needs_worktree
        : typeof obj.needsWorktree === "boolean"
          ? obj.needsWorktree
          : kind === "exec",
    defaultSeverityGrade:
      obj.default_severity_grade === "disabled" || obj.defaultSeverityGrade === "disabled"
        ? "disabled"
        : "enabled",
  };
}

function parseSkillFile(raw: string, filePath: string, name: string): AuditSkillFile | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const fm = parseFrontmatter(raw, name);
  if (!fm) return null;
  return { name: fm.name, filePath, frontmatter: fm, body: m[2] ?? "" };
}

/**
 * List audit skills installed in `<project>/.factory/audits/<name>/SKILL.md`.
 * Skips directories without a SKILL.md or with malformed frontmatter (logged
 * via console.warn so the operator notices).
 */
export async function listAuditSkills(projectPath: string): Promise<AuditSkillFrontmatter[]> {
  const dir = path.join(projectPath, ".factory", "audits");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: AuditSkillFrontmatter[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const raw = await readFile(skillFile, "utf8");
      const fm = parseFrontmatter(raw, entry.name);
      if (fm) skills.push(fm);
      else console.warn(`[audit-skills] malformed frontmatter: ${skillFile}`);
    } catch (err) {
      console.warn(
        `[audit-skills] failed to read ${skillFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Read the full skill file (frontmatter + body). Returns null when absent. */
export async function readAuditSkill(
  projectPath: string,
  skillName: string,
): Promise<AuditSkillFile | null> {
  const filePath = path.join(projectPath, ".factory", "audits", skillName, "SKILL.md");
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf8");
  return parseSkillFile(raw, filePath, skillName);
}
