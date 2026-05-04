import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Audit } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import YAML from "yaml";
import type { FactoryConfig } from "../config.ts";

export interface AuditCommitInput {
  config: FactoryConfig;
  workdirPath: string;
  audit: Audit;
  /** Defaults to `new Date()`; override for deterministic tests. */
  now?: () => Date;
}

export interface AuditCommitResult {
  /** Repo-relative path of the report markdown file. */
  reportPath: string;
}

/**
 * Commit an approved audit report to the project repo. The report markdown
 * lands at `<project>/docs/internal/audits/<YYYY-MM-DD>-<slug>.md` (or
 * operator-overridden `report_path` from `<project>/.factory/audits.yaml`).
 *
 * Filename collisions on the same day get a `-2`, `-3` suffix.
 */
export async function commitApprovedAuditReport(
  input: AuditCommitInput,
): Promise<AuditCommitResult> {
  const { config, workdirPath, audit } = input;
  if (!audit.reportMarkdown || audit.reportMarkdown.trim().length === 0) {
    throw new Error(`audit ${audit.id} has no report markdown to commit`);
  }
  const targetDir = await resolveReportDir(workdirPath);
  const absDir = path.join(workdirPath, targetDir);
  await mkdir(absDir, { recursive: true });

  const date = (input.now?.() ?? new Date()).toISOString().slice(0, 10);
  const slug = slugify(audit.skillName) || "audit";
  const filename = await pickAvailableFilename(absDir, date, slug);
  const repoRelative = path.posix.join(targetDir, filename);
  const absPath = path.join(absDir, filename);
  await writeFile(absPath, ensureTrailingNewline(audit.reportMarkdown), "utf8");

  await commitAllChanges(
    workdirPath,
    `docs: approve audit report — ${audit.skillName}`,
    config.gitAuthor,
  );

  return { reportPath: repoRelative };
}

const DEFAULT_REPORT_DIR = "docs/internal/audits";

async function resolveReportDir(workdirPath: string): Promise<string> {
  const cfg = path.join(workdirPath, ".factory", "audits.yaml");
  if (!existsSync(cfg)) return DEFAULT_REPORT_DIR;
  try {
    const raw = await readFile(cfg, "utf8");
    const parsed = YAML.parse(raw) as { report_path?: unknown } | null;
    if (parsed && typeof parsed.report_path === "string" && parsed.report_path.trim().length > 0) {
      // Operator-supplied paths land relative to the project root; strip a
      // leading slash defensively.
      return parsed.report_path.replace(/^\/+/, "");
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_REPORT_DIR;
}

async function pickAvailableFilename(absDir: string, date: string, slug: string): Promise<string> {
  const base = `${date}-${slug}`;
  const candidate = `${base}.md`;
  if (!existsSync(path.join(absDir, candidate))) return candidate;
  for (let i = 2; i < 100; i++) {
    const next = `${base}-${i}.md`;
    if (!existsSync(path.join(absDir, next))) return next;
  }
  throw new Error(`could not allocate report filename for ${base}`);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}
