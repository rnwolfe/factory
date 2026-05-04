import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditSkillFrontmatter } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import type { FactoryConfig } from "../config.ts";
import { parseFrontmatter } from "../projects/audit-skills.ts";

/**
 * Resolve the directory holding shipped audit skill templates. By default
 * this is `<factory-root>/docs/audit-skill-templates/`, which we locate via
 * the source file's URL — the same trick used in `index.ts` for the PWA dist.
 * `FACTORY_AUDIT_TEMPLATES_DIR` overrides for tests.
 */
export function templatesDir(): string {
  if (process.env.FACTORY_AUDIT_TEMPLATES_DIR) {
    return process.env.FACTORY_AUDIT_TEMPLATES_DIR;
  }
  return new URL("../../../../docs/audit-skill-templates", import.meta.url).pathname;
}

export interface AuditTemplateSummary {
  name: string;
  frontmatter: AuditSkillFrontmatter;
}

export async function listAuditTemplates(): Promise<AuditTemplateSummary[]> {
  const dir = templatesDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const templates: AuditTemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, "SKILL.md");
    if (!existsSync(filePath)) continue;
    try {
      const raw = await readFile(filePath, "utf8");
      const fm = parseFrontmatter(raw, entry.name);
      if (fm) templates.push({ name: fm.name, frontmatter: fm });
      else console.warn(`[audit-templates] malformed frontmatter: ${filePath}`);
    } catch (err) {
      console.warn(
        `[audit-templates] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

export interface InstallTemplateInput {
  config: FactoryConfig;
  workdirPath: string;
  templateName: string;
}

export interface InstallTemplateResult {
  installedPath: string;
  frontmatter: AuditSkillFrontmatter;
  alreadyInstalled: boolean;
}

/**
 * Copy a shipped template SKILL.md into `<project>/.factory/audits/<name>/`
 * and commit it on the project's main branch. If the file already exists we
 * leave it alone — operators may have customized it locally and we should not
 * silently clobber. The router translates that into a friendly message.
 */
export async function installAuditTemplate(
  input: InstallTemplateInput,
): Promise<InstallTemplateResult> {
  const srcDir = templatesDir();
  const srcFile = path.join(srcDir, input.templateName, "SKILL.md");
  if (!existsSync(srcFile)) {
    throw new Error(`audit template "${input.templateName}" not found`);
  }
  const raw = await readFile(srcFile, "utf8");
  const fm = parseFrontmatter(raw, input.templateName);
  if (!fm) {
    throw new Error(`audit template "${input.templateName}" has malformed frontmatter`);
  }

  const targetDir = path.join(input.workdirPath, ".factory", "audits", fm.name);
  const targetFile = path.join(targetDir, "SKILL.md");
  if (existsSync(targetFile)) {
    return { installedPath: targetFile, frontmatter: fm, alreadyInstalled: true };
  }

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetFile, raw, "utf8");
  await commitAllChanges(
    input.workdirPath,
    `chore(audits): install ${fm.name} skill`,
    input.config.gitAuthor,
  );
  return { installedPath: targetFile, frontmatter: fm, alreadyInstalled: false };
}
