import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import { recordAutonomyEvent } from "../autonomy/events.ts";
import type { SubmitRunDeps } from "./submit.ts";
import { hasActionableDefect, renderVerifierFindings, type VerifierReport } from "./verifier.ts";

/**
 * L3 bounded auto-retry (ADR-012 L3 / ADR-016 slice 4). When the verifier gate
 * holds an autonomous run for an ACTIONABLE defect (a real `fail` — cross-model,
 * acceptance, or quality — not an `absent`-only coverage gap), retry it
 * automatically with the findings injected as feedback, up to `retry.verifierBudget`
 * attempts, then surface to the operator.
 *
 * Safe by construction: the retry RE-RUNS THE GATE. Unverified work still cannot
 * merge (the gate keeps demanding `high`), so the worst case of a non-converging
 * loop is bounded wasted compute — never a bad merge. Contraction remains the
 * circuit breaker for true failures.
 */

/** Walk the `retry_of_run_id` lineage back from `runId`, counting prior retries. */
function retryChainDepth(db: Db, runId: string): number {
  let depth = 0;
  let cur: string | null = runId;
  // Bounded walk; the hard cap also guards against a pathological cycle.
  for (let i = 0; i < 20 && cur; i++) {
    const row = db
      .select({ prev: schema.runs.retryOfRunId })
      .from(schema.runs)
      .where(eq(schema.runs.id, cur))
      .get();
    cur = row?.prev ?? null;
    if (cur) depth++;
  }
  return depth;
}

export interface GateRetryArgs {
  runId: string;
  projectId: string;
  projectName: string;
  taskId: string | null;
  report: VerifierReport;
}

/**
 * Returns the new retry run's id when it auto-retried, or `null` when the run
 * should surface to the operator instead (budget 0/exhausted, no actionable
 * defect, or the retry submit failed — e.g. a provider that can't resume).
 */
export async function maybeAutoRetryGatedRun(
  deps: SubmitRunDeps,
  args: GateRetryArgs,
): Promise<string | null> {
  const cfg = resolveAutonomyConfig(deps.db, args.projectId);
  const budget = cfg.retry.verifierBudget;
  if (budget <= 0) return null; // opted out → always surface (today's behavior)
  if (!hasActionableDefect(args.report)) return null; // absent-only → surface
  if (retryChainDepth(deps.db, args.runId) >= budget) return null; // exhausted → surface
  const attempt = retryChainDepth(deps.db, args.runId) + 1;

  const feedback = renderVerifierFindings(args.report);
  let retryRunId: string;
  try {
    const { submitRun } = await import("./submit.ts");
    const res = await submitRun(deps, {
      projectId: args.projectId,
      taskId: args.taskId ?? undefined,
      reuseFromRunId: args.runId,
      retryOfRunId: args.runId,
      operatorContext: feedback,
    });
    retryRunId = res.runId;
  } catch (err) {
    // The retry couldn't be submitted (e.g. a provider with no resume support).
    // Degrade safely: surface the block so the operator drives it.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-retry] could not auto-retry ${args.runId}: ${msg}`);
    return null;
  }

  const failed = args.report.signals
    .filter((s) => s.state === "fail")
    .map((s) => s.label)
    .join(", ");
  recordAutonomyEvent(deps.db, deps.events, {
    kind: "auto_retried",
    projectId: args.projectId,
    runId: retryRunId,
    message: `${args.projectName} auto-retried a gate-held run (attempt ${attempt}/${budget}) — fixing: ${failed}`,
    detail: { sourceRunId: args.runId, failed },
  });
  return retryRunId;
}
