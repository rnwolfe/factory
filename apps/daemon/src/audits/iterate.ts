import type { Audit, Db } from "@factory/db";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { readAuditSkill } from "../projects/audit-skills.ts";
import { parseAuditResponse, writeFindings } from "./findings.ts";
import { buildAuditPrompt, gatherProjectContext } from "./prompts.ts";

export interface AuditAgentInvocation {
  prompt: string;
  resumeSessionId?: string;
}

export interface AuditIterationOptions {
  /** Test seam mirroring runPlanIteration. */
  agentInvoker?: (call: AuditAgentInvocation) => Promise<InvokeClaudeResult>;
  budgetSeconds?: number;
  now?: () => number;
}

export interface AuditIterationResult {
  auditId: string;
  /** True if the agent emitted a parseable report. */
  reportPersisted: boolean;
  /** Final audit row state. */
  audit: Audit;
  /** Parse error message when parsing failed. */
  parseError: string | null;
  sessionId: string | null;
}

/**
 * Run a read-only audit end-to-end: load skill + project context, invoke the
 * agent, parse the report, persist findings + report markdown.
 *
 * Mirrors v0.2 runPlanIteration shape. Null parse → status='failed', never
 * silently 'completed'. Exec audits go through a separate code path
 * (runtime.spawn) and are not handled here.
 */
export async function runAuditIteration(
  db: Db,
  auditId: string,
  opts: AuditIterationOptions = {},
): Promise<AuditIterationResult> {
  const now = (opts.now ?? Date.now)();

  const audit = await db.select().from(schema.audits).where(eq(schema.audits.id, auditId)).get();
  if (!audit) throw new Error(`audit ${auditId} not found`);
  if (audit.status !== "running") {
    throw new Error(`audit ${auditId} is ${audit.status}; only running audits iterate`);
  }

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, audit.projectId))
    .get();
  if (!project) throw new Error(`project ${audit.projectId} not found`);

  const skill = await readAuditSkill(project.workdirPath, audit.skillName);
  if (!skill) {
    return await failAudit(db, audit, now, `skill ${audit.skillName} not found in project`);
  }
  if (skill.frontmatter.kind !== "read-only") {
    throw new Error(
      `runAuditIteration only handles read-only skills; got ${skill.frontmatter.kind}`,
    );
  }

  const context = await gatherProjectContext({
    workdirPath: project.workdirPath,
    projectName: project.name,
  });
  const prompt = buildAuditPrompt({ skill, projectName: project.name, ...context });

  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  const agent = resolveAgent(db);
  let invocation: InvokeClaudeResult;
  try {
    if (opts.agentInvoker) {
      invocation = await opts.agentInvoker({ prompt });
    } else {
      invocation = await invokeClaudeJson(prompt, { budgetSeconds: budget, agent });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await failAudit(db, audit, now, `agent invocation failed: ${message.slice(0, 200)}`);
  }

  const parsed = parseAuditResponse(invocation.text);
  if (!parsed.ok) {
    return await failAudit(db, audit, now, `parse failed: ${parsed.error.slice(0, 240)}`);
  }

  await db
    .update(schema.audits)
    .set({
      status: "completed",
      completedAt: now,
      reportMarkdown: parsed.reportMarkdown,
      findings: writeFindings(parsed.findings),
      claudeSessionId: invocation.sessionId,
    })
    .where(eq(schema.audits.id, audit.id));

  if (invocation.metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "audit",
      ownerId: audit.id,
      projectId: project.id,
      metrics: invocation.metrics,
      now,
    });
  }

  const refreshed = await db
    .select()
    .from(schema.audits)
    .where(eq(schema.audits.id, audit.id))
    .get();
  return {
    auditId: audit.id,
    reportPersisted: true,
    audit: refreshed ?? { ...audit, status: "completed", completedAt: now },
    parseError: null,
    sessionId: invocation.sessionId,
  };
}

async function failAudit(
  db: Db,
  audit: Audit,
  now: number,
  reason: string,
): Promise<AuditIterationResult> {
  const failureMd = `# ${audit.skillName} — failed\n\n_Audit run did not produce a parseable report._\n\nReason: ${reason}\n`;
  await db
    .update(schema.audits)
    .set({
      status: "failed",
      completedAt: now,
      reportMarkdown: failureMd,
    })
    .where(eq(schema.audits.id, audit.id));
  const refreshed = await db
    .select()
    .from(schema.audits)
    .where(eq(schema.audits.id, audit.id))
    .get();
  return {
    auditId: audit.id,
    reportPersisted: false,
    audit: refreshed ?? { ...audit, status: "failed", completedAt: now, reportMarkdown: failureMd },
    parseError: reason,
    sessionId: null,
  };
}
