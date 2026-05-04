import type { PlanKind } from "@factory/db";

/**
 * Prompt-key constants per plan kind. Mirrors the triage `prompt_key` pattern
 * — each is stored in the `prompts` table and seeded by `db:seed`.
 */
export const PLAN_PROMPT_KEYS = {
  project_spec: "plan-project-spec-v1",
  task_plan: "plan-task-plan-v1",
  refinement: "plan-refinement-v1",
  feature_plan: "plan-feature-plan-v1",
  project_vision: "plan-project-vision-v1",
} as const satisfies Record<PlanKind, string>;

export function planPromptKey(kind: PlanKind): string {
  return PLAN_PROMPT_KEYS[kind];
}
