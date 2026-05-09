import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import type { AuditSkillFile } from "../projects/audit-skills.ts";

/**
 * Two-block envelope. The agent emits the report verbatim inside one
 * `factory-audit-report` fence, then the structured findings inside a
 * separate JSON fence. This is much more reliable than JSON-stringifying a
 * multi-paragraph markdown report — same pattern the run-executor uses with
 * `factory-status`.
 */
const AUDIT_REPORT_FOOTER = `
## Output contract

Emit **exactly two fenced blocks in order**, with no prose between or after.
The first character of your response must be a backtick.

### Block 1 — the operator-readable report

\`\`\`factory-audit-report
# <skill name> — <project name>

## Summary

<one to three sentences naming the scope you read and the headline result>

## Findings

<one section per finding using \`### <severity>: <title>\`, or the literal
text \`No findings.\` when nothing actionable was found>

<plus any skill-specific sections — per-doc walkthroughs, per-task tables,
per-commit reviews. The skill body tells you what extra structure to add.>
\`\`\`

The report is rendered as Markdown verbatim — do not JSON-escape newlines,
quotes, or code blocks. \`\`\` ticks inside your report content must be
written as four backticks (\`\`\`\`) to avoid closing the outer fence.

### Block 2 — the structured findings

\`\`\`json
{
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

\`findings\` is required. Emit \`"findings": []\` when nothing actionable
was found — the structured-empty case is how the operator distinguishes
"clean audit" from "audit failed."

Severity guide (consistent across all skills unless the skill body overrides):
- **critical** — would-break-prod, security, or data-loss
- **major** — significant logic error, contract violation, or stale-on-current-code
- **minor** — small bug, missing detail, or low-impact gap
- **enhancement** — not wrong, but worth doing
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
 * Render an audit prompt from the skill body. Skill author writes the
 * domain-specific instructions and criteria; Factory frames the project
 * context in a single appended section and adds the output-contract
 * footer. Skills do not interpolate context placeholders into their body —
 * the framework owns that surface so per-skill drift is impossible.
 */
export function buildAuditPrompt(input: BuildAuditPromptInput): string {
  const { skill, projectName, visionExcerpt, claudeMdExcerpt, recentCommits, priorAudits } = input;

  const header = [
    `# ${skill.frontmatter.name} — ${projectName}`,
    "",
    skill.body.trim(),
    "",
    "## Project context (framework-injected)",
    "",
    `### VISION.md (excerpt)`,
    "",
    visionExcerpt,
    "",
    `### CLAUDE.md (excerpt)`,
    "",
    claudeMdExcerpt,
    "",
    `### Recent commits`,
    "",
    recentCommits,
    "",
    `### Prior audit reports`,
    "",
    priorAudits,
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
