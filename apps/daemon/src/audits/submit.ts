import { type Db, type Project, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { readAuditSkill } from "../projects/audit-skills.ts";
import { runExecAudit } from "./exec-iterate.ts";
import { runAuditIteration } from "./iterate.ts";
import { computeSkillVersion } from "./prompts.ts";

/** How an audit was kicked off. Informational — carried on the started event. */
export type AuditTrigger = "operator" | "cadence";

export interface SubmitAuditArgs {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  project: Project;
  skillName: string;
  /** Defaults to "operator" (the manual router path). */
  trigger?: AuditTrigger;
}

export interface SubmitAuditResult {
  auditId: string;
}

/**
 * The single audit-execution path. Creates the `audits` row, publishes
 * `audit_started`, fans the read-only/exec iteration out into the background,
 * and publishes `audit_completed` when it settles (recording a failed row on
 * error). Both the operator router (`audits.submit`) and the cadence scheduler
 * job (`workers/audit-cadence.ts`) call this so there is exactly one place an
 * audit is spawned — the cadence layer never forks a parallel executor, which
 * is what keeps it read-mostly and identically isolated to a manual audit.
 *
 * Returns `null` when the named skill isn't installed in the project (the
 * router turns that into a NOT_FOUND; the cadence job simply skips it).
 */
export async function submitAudit(args: SubmitAuditArgs): Promise<SubmitAuditResult | null> {
  const { config, db, events, project, skillName } = args;

  const skill = await readAuditSkill(project.workdirPath, skillName);
  if (!skill) return null;

  const auditId = createId();
  const now = Date.now();
  const skillVersion = await computeSkillVersion(project.workdirPath, skillName);
  await db.insert(schema.audits).values({
    id: auditId,
    projectId: project.id,
    skillName,
    skillVersion,
    status: "running",
    startedAt: now,
  });
  events.publish({
    channel: "inbox",
    kind: "audit_started",
    auditId,
    projectId: project.id,
    skillName,
    trigger: args.trigger ?? "operator",
  });

  // Read-only and exec audits both fan out into the background. Read-only uses
  // `claude --print`, no worktree; exec creates a per-audit worktree and spawns
  // claude with cwd set so its shell tools see project state.
  const isExec = skill.frontmatter.kind === "exec";

  void (async () => {
    try {
      if (isExec) {
        await runExecAudit(config, db, auditId);
      } else {
        await runAuditIteration(db, auditId);
      }
      events.publish({
        channel: "inbox",
        kind: "audit_completed",
        auditId,
        projectId: project.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[audit-iterate] ${auditId}: ${message}`);
      await db
        .update(schema.audits)
        .set({
          status: "failed",
          completedAt: Date.now(),
          reportMarkdown: `# ${skillName} — failed\n\n${message.slice(0, 500)}\n`,
        })
        .where(eq(schema.audits.id, auditId));
      events.publish({
        channel: "inbox",
        kind: "audit_completed",
        auditId,
        projectId: project.id,
      });
    }
  })();

  return { auditId };
}
