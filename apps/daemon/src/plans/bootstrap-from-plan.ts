import type { Db } from "@factory/db";
import { type ProjectSpecDraft, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import { type BootstrapResult, bootstrapProject } from "../projects/bootstrap.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { parseStoredDraft } from "./iterate.ts";

/**
 * Bootstrap a project from a frozen `project_spec` plan. Constructs a
 * synthetic `TriageDecisionPayload` whose `spec_stub` is replaced by the
 * plan's draft, then defers to the existing `bootstrapProject` so the
 * disk-layout / git-init / task-files behavior stays in one place.
 *
 * The plan's draft is authoritative — we ignore the original triage
 * `spec_stub`. Title/summary/risks come from the plan; clarifying questions
 * from the original payload are dropped (they no longer apply).
 */
export async function bootstrapFromPlan(
  config: FactoryConfig,
  db: Db,
  planId: string,
): Promise<BootstrapResult> {
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
  if (!plan) throw new Error(`plan ${planId} not found`);
  if (plan.kind !== "project_spec") {
    throw new Error(`bootstrapFromPlan only handles project_spec; got ${plan.kind}`);
  }
  if (plan.status !== "frozen") {
    throw new Error(`plan ${planId} not frozen (status=${plan.status})`);
  }
  if (!plan.decisionId) throw new Error(`plan ${planId} missing decisionId`);

  const draft = parseStoredDraft(plan.draft) as ProjectSpecDraft;
  if (draft.kind !== "project_spec") {
    throw new Error(`plan ${planId} draft kind mismatch`);
  }

  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, plan.decisionId))
    .get();
  if (!decision) throw new Error(`decision ${plan.decisionId} not found`);
  if (!decision.ideaId) throw new Error(`decision ${plan.decisionId} missing ideaId`);

  const idea = await db
    .select()
    .from(schema.ideas)
    .where(eq(schema.ideas.id, decision.ideaId))
    .get();
  if (!idea) throw new Error(`idea ${decision.ideaId} not found`);

  const original = decision.payload as TriageDecisionPayload;

  // Construct a payload bootstrapProject understands. Title preference order:
  // plan.goal (operator-confirmed), original triage title_suggestion, idea
  // text. Summary comes from the plan.
  const payload: TriageDecisionPayload = {
    outcome: "greenlit",
    weighted_score: original.weighted_score,
    uncertainty: original.uncertainty,
    axes: original.axes,
    rationale: original.rationale,
    title_suggestion: original.title_suggestion ?? plan.goal,
    spec_stub: {
      summary: draft.summary,
      initial_tasks: draft.tasks.map((t) => ({
        title: t.title,
        estimate: t.estimate,
        acceptance: t.acceptance,
      })),
    },
  };

  // Plan ceremony falls back to the idea's intent, then to tinker. Role
  // also flows from idea intent (default owner) — the operator can flip
  // role on the project after bootstrap if needed.
  const ceremony = (plan.ceremony ?? idea.intentCeremony ?? "tinker") as
    | "tinker"
    | "personal"
    | "shared"
    | "production";
  const role = (idea.intentRole ?? "owner") as "owner" | "contributor";

  return bootstrapProject(config, db, {
    ideaId: idea.id,
    decisionId: decision.id,
    payload,
    ideaText: idea.rawText,
    ceremony,
    role,
    model: null,
  });
}
