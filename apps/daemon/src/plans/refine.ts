import type { Db } from "@factory/db";
import { type PlanDraft, type RefinementDraft, schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import {
  createTask,
  readTaskFile,
  renderAcceptanceBlock,
  updateTaskBody,
} from "../projects/tasks.ts";

export interface ApplyRefinementInput {
  config: FactoryConfig;
  db: Db;
  projectId: string;
  taskId: string;
  draft: PlanDraft;
}

export interface ApplyRefinementResult {
  rewroteAcceptance: boolean;
  followupTaskIds: string[];
}

/**
 * Apply a frozen refinement plan to the project's task files. Rewrites the
 * target task body's `## Acceptance` section when `revisedAcceptance` is
 * present, and emits each followup as a new task file. Commits everything
 * on `main` so the next run sees the change.
 *
 * If the agent returned neither `revisedAcceptance` nor `followups`, the
 * call is a no-op aside from the commit being skipped — the plan itself is
 * already marked frozen by the router.
 */
export async function applyRefinementFreeze(
  input: ApplyRefinementInput,
): Promise<ApplyRefinementResult> {
  const { config, db, projectId, taskId, draft } = input;
  if (draft.kind !== "refinement") {
    throw new Error(`applyRefinementFreeze called with non-refinement draft: ${draft.kind}`);
  }

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error(`project ${projectId} not found`);

  const task = await readTaskFile(project.workdirPath, taskId);
  if (!task) throw new Error(`task ${taskId} not found in project`);

  const refinement = draft as RefinementDraft;
  let rewroteAcceptance = false;
  const followupTaskIds: string[] = [];

  if (refinement.revisedAcceptance && refinement.revisedAcceptance.length > 0) {
    const newBody = rewriteAcceptanceSection(task.body, refinement.revisedAcceptance);
    await updateTaskBody(project.workdirPath, taskId, newBody);
    rewroteAcceptance = true;
  }

  if (refinement.followups && refinement.followups.length > 0) {
    for (const f of refinement.followups) {
      const created = await createTask(project.workdirPath, {
        title: f.title,
        body: `## Acceptance\n\n${renderAcceptanceBlock(null)}\n\n## Notes\n\nFollow-up emitted by refinement plan against ${taskId}.${refinement.feedback ? ` Operator note: ${refinement.feedback}` : ""}\n`,
        estimate: f.estimate,
        priority: "med",
        parent: taskId,
        labels: ["refinement-followup"],
      });
      followupTaskIds.push(created.id);
    }
  }

  if (rewroteAcceptance || followupTaskIds.length > 0) {
    const summary = [
      rewroteAcceptance ? `revised acceptance for ${taskId}` : null,
      followupTaskIds.length > 0 ? `+${followupTaskIds.length} follow-up(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await commitAllChanges(project.workdirPath, `refine: ${summary || taskId}`, config.gitAuthor);
  }

  return { rewroteAcceptance, followupTaskIds };
}

const ACCEPTANCE_HEADER_RE = /(^|\n)##\s+Acceptance\s*\n/i;

/**
 * Replace the body's `## Acceptance` section with the new criteria. If the
 * task body has no Acceptance section, prepend one. The next section header
 * (or end-of-body) terminates the existing block.
 */
function rewriteAcceptanceSection(body: string, criteria: string[]): string {
  const block = criteria.map((c) => `- [ ] ${c}`).join("\n");
  const newSection = `## Acceptance\n\n${block}\n`;

  const headerMatch = ACCEPTANCE_HEADER_RE.exec(body);
  if (!headerMatch) {
    return `${newSection}\n${body.trimStart()}`;
  }

  const headerStart = headerMatch.index + (headerMatch[1] ? headerMatch[1].length : 0);
  const afterHeader =
    headerStart + headerMatch[0].length - (headerMatch[1] ? headerMatch[1].length : 0);
  // Find the next ## section start, or end of body.
  const tail = body.slice(afterHeader);
  const nextHeaderRel = /\n##\s+/.exec(tail);
  const sectionEnd = nextHeaderRel ? afterHeader + nextHeaderRel.index + 1 : body.length;
  return `${body.slice(0, headerStart)}${newSection}\n${body.slice(sectionEnd)}`;
}
