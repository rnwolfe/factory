import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Audit, AuditFinding, Db, Project } from "@factory/db";
import { schema } from "@factory/db";
import { and, eq } from "drizzle-orm";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";

const PROMOTE_BUDGET_SECONDS = 60;
const PROMOTE_PROMPT_KEY = "audit-bridge-v1";

export interface PromoteAgentInvocation {
  prompt: string;
}

export interface PromoteOptions {
  agentInvoker?: (call: PromoteAgentInvocation) => Promise<InvokeClaudeResult>;
  budgetSeconds?: number;
}

export type PromoteRecommendation =
  | {
      recommendation: "plan";
      planKind: "task_plan" | "feature_plan";
      goal: string;
      reasoning: string;
    }
  | {
      recommendation: "bug";
      taskTitle: string;
      taskBody: string;
      reasoning: string;
    };

interface BridgeInput {
  db: Db;
  project: Project;
  audit: Audit;
  findings: AuditFinding[];
}

/**
 * Run the bridge claude call: take the selected findings, return a structured
 * routing decision (plan vs bug) with the agent's drafted goal/title/body.
 *
 * Mirrors v0.2's plan-iteration parse discipline: null parse throws to the
 * caller (the router decides whether to surface a 500 or fall back to a
 * deterministic "create bug" path; current behavior is to throw).
 */
export async function bridgePromoteFindings(
  input: BridgeInput,
  opts: PromoteOptions = {},
): Promise<PromoteRecommendation> {
  const { db, project, audit, findings } = input;
  if (findings.length === 0) {
    throw new Error("no findings provided to bridgePromoteFindings");
  }

  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, PROMOTE_PROMPT_KEY), eq(schema.prompts.active, true)))
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for ${PROMOTE_PROMPT_KEY} — re-run \`bun run seed\`?`);
  }

  const visionExcerpt = await readVisionExcerpt(project.workdirPath);
  const findingsMd = renderFindingsMarkdown(findings);

  const prompt = renderTemplate(promptRow.content, {
    PROJECT_NAME: project.name,
    PROJECT_CEREMONY: project.ceremony ?? "tinker",
    PROJECT_VISION_EXCERPT: visionExcerpt,
    AUDIT_SKILL_NAME: audit.skillName,
    FINDINGS_MARKDOWN: findingsMd,
  });

  const budget = Math.min(opts.budgetSeconds ?? PROMOTE_BUDGET_SECONDS, PROMOTE_BUDGET_SECONDS);
  const invocation = opts.agentInvoker
    ? await opts.agentInvoker({ prompt })
    : await invokeClaudeJson(prompt, { budgetSeconds: budget });

  if (invocation.metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "audit_promote",
      ownerId: audit.id,
      projectId: project.id,
      metrics: invocation.metrics,
    });
  }

  const parsed = extractJsonObject<Record<string, unknown>>(invocation.text);
  return coerceRecommendation(parsed);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function renderFindingsMarkdown(findings: AuditFinding[]): string {
  return findings
    .map((f, i) => {
      const fileRef = f.filePath
        ? ` (\`${f.filePath}${f.line !== null ? `:${f.line}` : ""}\`)`
        : "";
      return `### Finding ${i + 1} — ${f.severity}: ${f.title}${fileRef}\n\n${f.body}`;
    })
    .join("\n\n");
}

const VISION_EXCERPT_LIMIT = 1200;

async function readVisionExcerpt(workdirPath: string): Promise<string> {
  const visionPath = path.join(workdirPath, "docs", "internal", "VISION.md");
  if (!existsSync(visionPath)) return "(no vision doc)";
  try {
    const raw = await readFile(visionPath, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "(no vision doc)";
    return trimmed.length > VISION_EXCERPT_LIMIT
      ? `${trimmed.slice(0, VISION_EXCERPT_LIMIT)}\n…(truncated)`
      : trimmed;
  } catch {
    return "(no vision doc)";
  }
}

function coerceRecommendation(obj: Record<string, unknown>): PromoteRecommendation {
  const rec = obj.recommendation === "bug" ? "bug" : "plan";
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";

  if (rec === "bug") {
    return {
      recommendation: "bug",
      taskTitle:
        typeof obj.taskTitle === "string" && obj.taskTitle.length > 0
          ? obj.taskTitle
          : "Audit-promoted bug",
      taskBody:
        typeof obj.taskBody === "string" && obj.taskBody.length > 0
          ? obj.taskBody
          : "(agent did not provide a body)",
      reasoning,
    };
  }
  const planKind = obj.planKind === "feature_plan" ? "feature_plan" : "task_plan";
  return {
    recommendation: "plan",
    planKind,
    goal:
      typeof obj.goal === "string" && obj.goal.length > 0
        ? obj.goal
        : "(agent did not provide a goal — review and revise)",
    reasoning,
  };
}
