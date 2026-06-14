import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { EventBus } from "../events.ts";
import { runPlanIteration } from "./iterate.ts";

export interface PlanIterationScheduleRequest {
  planId: string;
  projectId?: string | null;
  errorLabel?: string;
}

export type PlanIterationScheduler = (request: PlanIterationScheduleRequest) => void;

interface PlanIterationScheduleContext {
  db: Db;
  events: EventBus;
  planIterationScheduler?: PlanIterationScheduler;
}

export function schedulePlanIteration(
  ctx: PlanIterationScheduleContext,
  request: PlanIterationScheduleRequest,
): void {
  if (ctx.planIterationScheduler) {
    ctx.planIterationScheduler(request);
    return;
  }

  void (async () => {
    try {
      const result = await runPlanIteration(ctx.db, request.planId);
      ctx.events.publish({
        channel: "inbox",
        kind: "plan_comment_added",
        planId: request.planId,
        role: "agent",
        projectId: request.projectId,
      });
      if (result.draftUpdated) {
        ctx.events.publish({
          channel: "inbox",
          kind: "plan_updated",
          planId: request.planId,
          projectId: request.projectId,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label = request.errorLabel ?? request.planId;
      console.error(`[plan-iterate] ${label}: ${message}`);
      await ctx.db.insert(schema.planComments).values({
        id: createId(),
        planId: request.planId,
        role: "agent",
        body: `(plan iteration failed: ${message.slice(0, 240)})`,
        createdAt: Date.now(),
      });
      ctx.events.publish({
        channel: "inbox",
        kind: "plan_comment_added",
        planId: request.planId,
        role: "agent",
        projectId: request.projectId,
      });
    }
  })();
}
