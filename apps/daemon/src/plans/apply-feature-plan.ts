import type { Db, FeaturePlanDraft } from "@factory/db";
import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import {
  applyDependsOnEdges,
  createTask,
  renderAcceptanceBlock,
  type TaskFile,
} from "../projects/tasks.ts";

export interface ApplyFeaturePlanInput {
  config: FactoryConfig;
  db: Db;
  projectId: string;
  draft: FeaturePlanDraft;
  planId: string;
}

export interface ApplyFeaturePlanResult {
  taskIds: string[];
}

/**
 * Apply a frozen feature_plan to the project. Emits each task in the draft as
 * a new task file under `.factory/work/`, then commits everything on `main`
 * so the next run sees the new tasks.
 *
 * Routes through `tasks.createTask` so the storage seam stays single-pointed.
 * The plan id is stored on each task's `sourcePlanId` frontmatter for audit
 * trail and UI provenance links.
 */
export async function applyFeaturePlanFreeze(
  input: ApplyFeaturePlanInput,
): Promise<ApplyFeaturePlanResult> {
  const { config, db, projectId, draft, planId } = input;
  if (draft.kind !== "feature_plan") {
    throw new Error(`applyFeaturePlanFreeze called with non-feature_plan draft: ${draft.kind}`);
  }
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error(`project ${projectId} not found`);

  const created: TaskFile[] = [];
  for (const t of draft.tasks) {
    created.push(
      await createTask(project, {
        title: t.title || "Untitled",
        body: `## Acceptance\n\n${renderAcceptanceBlock(t.acceptance)}\n\n## Notes\n\nEmitted by feature plan ${planId.slice(0, 8)}: "${draft.goal}"\n`,
        estimate: t.estimate ?? "small",
        priority: "med",
        labels: ["feature-plan-task"],
        sourcePlanId: planId,
      }),
    );
  }
  // Resolve any model-declared intra-batch ordering into blockedBy edges (ADR-019 §5)
  // before the commit, so the edges ship with the tasks. Parallel when unset.
  await applyDependsOnEdges(
    project,
    created,
    draft.tasks.map((t) => t.dependsOn),
  );
  const taskIds = created.map((c) => c.id);

  if (taskIds.length > 0) {
    await commitAllChanges(
      project.workdirPath,
      `feat: add ${taskIds.length} task${taskIds.length === 1 ? "" : "s"} from feature plan — ${draft.goal.slice(0, 60)}`,
      config.gitAuthor,
    );
  }

  return { taskIds };
}
