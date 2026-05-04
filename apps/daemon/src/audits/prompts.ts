import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import type { AuditSkillFile } from "../projects/audit-skills.ts";

const AUDIT_REPORT_FOOTER = `
## Output contract

Emit a single fenced JSON block with this shape:

\`\`\`json
{
  "reportMarkdown": "<full markdown report — operator-readable>",
  "findings": [
    {
      "severity": "critical|major|minor|enhancement",
      "title": "<short headline (<120 chars)>",
      "body": "<markdown details>",
      "filePath": "<repo-relative or null>",
      "line": <integer or null>
    }
  ]
}
\`\`\`

Findings is required; emit an empty array when nothing actionable was found.
The first character of your response must be \`{\` if not in a fence, or
\`\\\`\\\`\\\`\` if you wrap it in one.
`;

interface BuildAuditPromptInput {
  skill: AuditSkillFile;
  projectName: string;
  visionExcerpt: string;
  claudeMdExcerpt: string;
  recentCommits: string;
  priorAudits: string;
}

/**
 * Render an audit prompt from the skill body with placeholder substitution.
 * Skill author writes the *body* (domain-specific instructions, criteria,
 * examples). Factory adds a project-context preamble and the output-contract
 * footer.
 */
export function buildAuditPrompt(input: BuildAuditPromptInput): string {
  const { skill, projectName, visionExcerpt, claudeMdExcerpt, recentCommits, priorAudits } = input;
  let body = skill.body;
  const subs: Record<string, string> = {
    SKILL_NAME: skill.frontmatter.name,
    PROJECT_NAME: projectName,
    VISION_EXCERPT: visionExcerpt,
    CLAUDE_MD_EXCERPT: claudeMdExcerpt,
    RECENT_COMMITS: recentCommits,
    PRIOR_AUDITS: priorAudits,
    SKILL_BODY: skill.body,
  };
  for (const [k, v] of Object.entries(subs)) {
    body = body.replaceAll(`{{${k}}}`, v);
  }

  const header = [
    `# ${skill.frontmatter.name} — ${projectName}`,
    "",
    body,
    "",
    "## Project context",
    "",
    `- Vision (excerpt): ${visionExcerpt}`,
    `- CLAUDE.md (excerpt): ${claudeMdExcerpt}`,
    `- Recent commits: ${recentCommits}`,
    `- Prior audit summaries: ${priorAudits}`,
  ].join("\n");

  return `${header}\n${AUDIT_REPORT_FOOTER}`;
}

const EXCERPT_LIMIT = 1500;

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(none)";
  if (trimmed.length <= EXCERPT_LIMIT) return trimmed;
  return `${trimmed.slice(0, EXCERPT_LIMIT)}\n…(truncated)`;
}

async function readIfPresent(filePath: string): Promise<string> {
  if (!existsSync(filePath)) return "(none)";
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "(none)";
  }
}

async function gitLogTail(projectPath: string, n = 30): Promise<string> {
  if (!existsSync(path.join(projectPath, ".git"))) return "(no git history)";
  try {
    const proc = bunSpawn({
      cmd: ["git", "log", `-n${n}`, "--pretty=format:%h %s"],
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : "(no commits)";
  } catch {
    return "(no git history)";
  }
}

export interface ProjectContextSources {
  workdirPath: string;
  projectName: string;
}

/**
 * Gather the project-context sources to feed into the audit prompt:
 * VISION.md excerpt, CLAUDE.md excerpt, recent git log.
 *
 * Approved-audit summaries are intentionally minimal — the spec leaves
 * cross-audit awareness to the docs-audit skill flagging stale references.
 */
export async function gatherProjectContext(src: ProjectContextSources): Promise<{
  visionExcerpt: string;
  claudeMdExcerpt: string;
  recentCommits: string;
  priorAudits: string;
}> {
  const [vision, claudeMd, log] = await Promise.all([
    readIfPresent(path.join(src.workdirPath, "docs", "internal", "VISION.md")),
    readIfPresent(path.join(src.workdirPath, "CLAUDE.md")),
    gitLogTail(src.workdirPath),
  ]);
  return {
    visionExcerpt: excerpt(vision),
    claudeMdExcerpt: excerpt(claudeMd),
    recentCommits: log,
    priorAudits: "(see docs/internal/audits/ in the project repo)",
  };
}

/** Compute the SHA of `SKILL.md` for skillVersion stamping. */
export async function computeSkillVersion(projectPath: string, skillName: string): Promise<string> {
  const skillFile = path.join(".factory", "audits", skillName, "SKILL.md");
  if (!existsSync(path.join(projectPath, ".git"))) return "untracked";
  try {
    const proc = bunSpawn({
      cmd: ["git", "log", "-1", "--pretty=format:%H", "--", skillFile],
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const sha = out.trim();
    return sha.length > 0 ? sha : "unstaged";
  } catch {
    return "unstaged";
  }
}
