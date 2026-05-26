import path from "node:path";
import type { Audit, Db, Project } from "@factory/db";
import { schema } from "@factory/db";
import { ensureWorktree, removeWorktree } from "@factory/runtime";
import { eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { FactoryConfig } from "../config.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { readAuditSkill } from "../projects/audit-skills.ts";
import { parseAuditResponse, writeFindings } from "./findings.ts";
import { buildAuditPrompt, gatherProjectContext } from "./prompts.ts";

export interface ExecAuditOptions {
  budgetSeconds?: number;
  now?: () => number;
}

export interface ExecAuditResult {
  auditId: string;
  reportPersisted: boolean;
  audit: Audit;
  parseError: string | null;
}

/**
 * Run an exec-kind audit: create a per-audit worktree, spawn claude with the
 * worktree as cwd so its shell tools see the project's tracked state, parse
 * the JSON envelope from the agent's output, persist the report.
 *
 * Worktree branch is `factory/audit-<auditId>`. After the audit completes
 * the worktree is torn down (audits don't preserve commits — they read).
 */
export async function runExecAudit(
  config: FactoryConfig,
  db: Db,
  auditId: string,
  opts: ExecAuditOptions = {},
): Promise<ExecAuditResult> {
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
    return failAudit(db, audit, now, `skill ${audit.skillName} not found in project`);
  }
  if (skill.frontmatter.kind !== "exec") {
    throw new Error(`runExecAudit only handles exec skills; got ${skill.frontmatter.kind}`);
  }

  const branch = `factory/audit-${auditId}`;
  const worktreePath = path.join(config.worktreesRoot, project.slug, `audit-${auditId}`);

  let worktreeCreated = false;
  try {
    const wt = await ensureWorktree({
      projectPath: project.workdirPath,
      branch,
      worktreePath,
    });
    worktreeCreated = wt.created;

    await db
      .update(schema.audits)
      .set({ worktreePath: wt.worktreePath })
      .where(eq(schema.audits.id, audit.id));

    const context = await gatherProjectContext({
      workdirPath: project.workdirPath,
      projectName: project.name,
    });
    const prompt = buildAuditPrompt({ skill, projectName: project.name, ...context });
    const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
    const agent = resolveAgent(db, { projectAgent: project.agent });
    const invocation = await invokeClaudeJson(prompt, {
      budgetSeconds: budget,
      agent,
      cwd: wt.worktreePath,
    });

    const parsed = parseAuditResponse(invocation.text);
    if (!parsed.ok) {
      return failAudit(
        db,
        audit,
        now,
        `parse failed: ${parsed.error.slice(0, 240)}`,
        project,
        branch,
        worktreePath,
      );
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
      await recordAgentMetrics({
        db,
        ownerKind: "audit_exec",
        ownerId: audit.id,
        projectId: project.id,
        agent,
        metrics: invocation.metrics,
        now,
      });
    }

    // Audits don't preserve commits. Tear down the worktree on success.
    await tryRemoveWorktree(project.workdirPath, worktreePath);

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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (worktreeCreated) await tryRemoveWorktree(project.workdirPath, worktreePath);
    return failAudit(db, audit, now, `exec audit failed: ${message.slice(0, 240)}`);
  }
}

async function tryRemoveWorktree(projectPath: string, worktreePath: string): Promise<void> {
  try {
    await removeWorktree({ projectPath, worktreePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-exec] worktree teardown failed: ${message}`);
  }
}

async function failAudit(
  db: Db,
  audit: Audit,
  now: number,
  reason: string,
  _project?: Project,
  _branch?: string,
  worktreePath?: string,
): Promise<ExecAuditResult> {
  const failureMd = `# ${audit.skillName} — failed\n\n_Audit run did not produce a parseable report._\n\nReason: ${reason}\n`;
  const update: Partial<typeof schema.audits.$inferInsert> = {
    status: "failed",
    completedAt: now,
    reportMarkdown: failureMd,
  };
  if (worktreePath) update.worktreePath = worktreePath;
  await db.update(schema.audits).set(update).where(eq(schema.audits.id, audit.id));
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
  };
}
