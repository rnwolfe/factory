import type { Db } from "@factory/db";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import type { FactoryConfig } from "../config.ts";
import type { InvokeClaudeResult } from "../plans/invoke-claude.ts";
import {
  type BlastClassification,
  classifyMilestoneBlastRadius,
  isWithinBlastCeiling,
} from "../workers/verifier.ts";
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
 * Blast-radius gated: the daemon only auto-confirms a decomposition whose
 * plan-time blast radius (`classifyMilestoneBlastRadius`) is within the same
 * ceiling hands-off already applies to autorun (`autorun.maxBlastRadius`,
 * "contained"). A decomposition that exceeds the ceiling — a `large`-estimate
 * task, a risk-sensitive topic (auth/migration/infra/…), or too many tasks — is
 * NOT confirmed; it returns `created: 0` so the caller falls back to the manual
 * queue-empty nudge, leaving the next milestone for the operator to review and
 * confirm (the pre-existing manual-confirm behavior). This mirrors the post-run
 * auto-land gate: contained work runs unattended, broad work waits for a human.
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
  /** How many tasks `confirmMilestone` created (0 = nothing auto-confirmed). */
  created: number;
  milestone: string | null;
  taskIds: string[];
  /**
   * Why this returned. `confirmed` → tasks created (created > 0). `empty` → the
   * agent found nothing to build. `blast_exceeded` → a non-empty decomposition
   * was left for manual review because it exceeds the ceiling. `error` → a soft
   * failure (no SPEC, agent error, …). Only `confirmed` replenishes the queue;
   * every other outcome falls back to the manual nudge.
   */
  outcome: "confirmed" | "empty" | "blast_exceeded" | "error";
  /** The plan-time blast classification, when a decomposition was produced. */
  blast?: BlastClassification;
}

const EMPTY: AutoPlanResult = {
  created: 0,
  milestone: null,
  taskIds: [],
  outcome: "empty",
};

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

    // Blast-radius gate: only auto-confirm a decomposition within the same
    // ceiling hands-off applies to autorun. A broader decomposition (large task,
    // risk-sensitive topic, or too many tasks) is left for operator review — we
    // return without confirming so the caller falls back to the manual nudge.
    const ceiling = resolveAutonomyConfig(db, project.id).autorun.maxBlastRadius;
    const blast = classifyMilestoneBlastRadius(tasks);
    if (!isWithinBlastCeiling(blast.radius, ceiling)) {
      console.info(
        `[auto-milestone] milestone ${decomposition.milestone} for project ${project.id} exceeds the ${ceiling} blast-radius bar (${blast.reasons.join(
          "; ",
        )}) — left for manual review`,
      );
      return {
        created: 0,
        milestone: decomposition.milestone,
        taskIds: [],
        outcome: "blast_exceeded",
        blast,
      };
    }

    const { taskIds } = await confirmMilestone(config, project, {
      milestone: decomposition.milestone,
      tasks,
    });
    return {
      created: taskIds.length,
      milestone: decomposition.milestone,
      taskIds,
      outcome: "confirmed",
      blast,
    };
  } catch (err) {
    // No committed SPEC.md, missing prompt, or agent failure. Degrade to the
    // queue-empty nudge rather than break the post-merge chain.
    console.warn(
      `[auto-milestone] auto-plan skipped for project ${project.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ...EMPTY, outcome: "error" };
  }
}
