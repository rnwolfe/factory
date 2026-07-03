import type { Db } from "@factory/db";
import type { FactoryConfig } from "../config.ts";
import type { InvokeClaudeResult } from "../plans/invoke-claude.ts";
import {
  confirmMilestone,
  type MilestoneProject,
  proposeMilestone,
} from "./milestone-decompose.ts";

/**
 * Auto-plan the next milestone for a hands-off project whose ready queue just
 * drained, WITHOUT any operator interaction — the daemon-side equivalent of the
 * operator opening the milestone-plan screen and tapping "confirm".
 *
 * This is the "auto-plan" half of the hands-off auto-plan + auto-execute loop
 * (see the queue-drain branch in `workers/post-merge.ts`): `proposeMilestone`
 * re-decomposes the committed SPEC into the next milestone's tasks, and — only
 * when that yields at least one task — `confirmMilestone` materializes them
 * (tagged, dependency-linked, committed on main). The caller then hands the
 * fresh queue to the existing auto-advance chain.
 *
 * Fails soft: any failure (no committed SPEC.md, missing prompt row, agent
 * error, or an empty decomposition) returns `created: 0` so the caller falls
 * back to the manual queue-empty nudge. Never throws — a milestone the daemon
 * can't draft must degrade to today's behavior, not break post-merge.
 */

export interface AutoPlanDeps {
  config: FactoryConfig;
  db: Db;
  /** Test/override seam forwarded to `proposeMilestone`; omitted → real agent. */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
}

export interface AutoPlanResult {
  /** How many tasks `confirmMilestone` created (0 = nothing planned). */
  created: number;
  milestone: string | null;
  taskIds: string[];
}

const EMPTY: AutoPlanResult = { created: 0, milestone: null, taskIds: [] };

export async function autoPlanNextMilestone(
  deps: AutoPlanDeps,
  project: MilestoneProject,
): Promise<AutoPlanResult> {
  const { config, db, agentInvoker } = deps;
  try {
    const { decomposition } = await proposeMilestone(
      db,
      project,
      {},
      agentInvoker ? { agentInvoker } : {},
    );
    const tasks = decomposition.tasks.filter(Boolean);
    // Precondition of the feature: only auto-confirm a NON-empty decomposition.
    // An empty one means the agent found nothing to build next — nudge instead.
    if (tasks.length === 0) return EMPTY;

    const { taskIds } = await confirmMilestone(config, project, {
      milestone: decomposition.milestone,
      tasks,
    });
    return { created: taskIds.length, milestone: decomposition.milestone, taskIds };
  } catch (err) {
    // No committed SPEC.md, missing prompt, or agent failure. Degrade to the
    // queue-empty nudge rather than break the post-merge chain.
    console.warn(
      `[auto-milestone] auto-plan skipped for project ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return EMPTY;
  }
}
