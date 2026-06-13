import { type Db, type FeaturePlanDraft, schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import { createTask } from "../projects/tasks.ts";
import type { FeedbackDraft } from "./iterate.ts";
import { setFeedbackStatus } from "./store.ts";

export class PromoteError extends Error {
  constructor(
    public readonly code:
      | "no_factory_project"
      | "feedback_not_found"
      | "no_draft"
      | "project_not_found",
    message: string,
  ) {
    super(message);
    this.name = "PromoteError";
  }
}

/** Pull the latest agent draft from the thread, or null if none yet. */
export function latestDraft(db: Db, feedbackId: string): FeedbackDraft | null {
  const row = db
    .select()
    .from(schema.feedbackComments)
    .where(eq(schema.feedbackComments.feedbackId, feedbackId))
    .orderBy(desc(schema.feedbackComments.createdAt))
    .all()
    .find((c) => c.role === "agent" && c.resultingDraft !== null);
  if (!row?.resultingDraft) return null;
  try {
    return JSON.parse(row.resultingDraft) as FeedbackDraft;
  } catch {
    return null;
  }
}

interface PromoteContext {
  config: FactoryConfig;
  db: Db;
  feedbackId: string;
}

/**
 * Promote the feedback to a `feature_plan` plan on the configured factory
 * meta-project. Seeds the plan with the most recent agent draft (or a stub
 * if none yet). The plan is created in `drafting` status — the operator
 * can iterate on it and freeze later.
 */
export async function promoteToPlan(ctx: PromoteContext): Promise<{ planId: string }> {
  const { config, db, feedbackId } = ctx;
  if (!config.factoryProjectId) {
    throw new PromoteError(
      "no_factory_project",
      "no factoryProjectId configured — set it in ~/.factory/config.yaml",
    );
  }
  const fb = db.select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId)).get();
  if (!fb) throw new PromoteError("feedback_not_found", "feedback not found");
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, config.factoryProjectId))
    .get();
  if (!project) {
    throw new PromoteError(
      "project_not_found",
      `factoryProjectId=${config.factoryProjectId} does not match any project`,
    );
  }

  const draft = latestDraft(db, feedbackId);
  const goal = draft?.title || `feedback: ${fb.body.slice(0, 60)}`;
  const summary = draft?.summary || fb.body;

  const featurePlan: FeaturePlanDraft = {
    kind: "feature_plan",
    goal,
    summary,
    tasks: [],
    unknowns: [],
    risks: [],
    visionFilter: {
      identity: { passes: false, reasoning: "(not yet evaluated)" },
      principle: { passes: false, reasoning: "(not yet evaluated)" },
      phase: { passes: false, reasoning: "(not yet evaluated)" },
      replacement: { passes: false, reasoning: "(not yet evaluated)" },
    },
  };

  const planId = createId();
  const now = Date.now();
  db.insert(schema.plans)
    .values({
      id: planId,
      kind: "feature_plan",
      status: "drafting",
      decisionId: null,
      projectId: project.id,
      taskId: null,
      goal,
      draft: JSON.stringify(featurePlan),
      createdAt: now,
      updatedAt: now,
      ceremony: project.ceremony ?? "tinker",
    })
    .run();

  setFeedbackStatus(db, feedbackId, "resolved", { resolvedTarget: `plan:${planId}` });
  return { planId };
}

/**
 * Promote the feedback to a single task on the factory meta-project. Picks
 * a title and body from the latest agent draft (or falls back to the
 * feedback body verbatim).
 */
export async function promoteToTask(ctx: PromoteContext): Promise<{
  projectId: string;
  taskId: string;
}> {
  const { config, db, feedbackId } = ctx;
  if (!config.factoryProjectId) {
    throw new PromoteError(
      "no_factory_project",
      "no factoryProjectId configured — set it in ~/.factory/config.yaml",
    );
  }
  const fb = db.select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId)).get();
  if (!fb) throw new PromoteError("feedback_not_found", "feedback not found");
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, config.factoryProjectId))
    .get();
  if (!project) {
    throw new PromoteError(
      "project_not_found",
      `factoryProjectId=${config.factoryProjectId} does not match any project`,
    );
  }

  const draft = latestDraft(db, feedbackId);
  const title = draft?.title || `feedback: ${fb.body.slice(0, 60)}`;
  const body = [
    "## Source",
    "",
    `Captured from feedback ${feedbackId} (${fb.contextHint ?? "—"} on ${fb.contextRoute ?? "—"}).`,
    "",
    "## Operator's note",
    "",
    fb.body,
    draft?.summary ? `\n## Agent's draft\n\n${draft.summary}` : "",
    "",
    "## Acceptance",
    "",
    "- [ ] (TBD)",
  ].join("\n");

  const created = await createTask(project, {
    title,
    body,
    labels: ["feedback"],
  });

  await commitAllChanges(
    project.workdirPath,
    `chore: capture ${created.id} — feedback ${feedbackId.slice(0, 6)}`,
    config.gitAuthor,
  );

  setFeedbackStatus(db, feedbackId, "resolved", {
    resolvedTarget: `task:${project.id}:${created.id}`,
  });
  return { projectId: project.id, taskId: created.id };
}
