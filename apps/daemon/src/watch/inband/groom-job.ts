import type { Cadence, ScheduledJob } from "../../workers/scheduler.ts";
import type { DedupeBacklogFn, SaveObservationsFn } from "../synthesis-job.ts";
import type { RawObservation } from "../synthesize.ts";

/**
 * The in-band groom job (ADR-011 §2). On cadence it runs the deterministic in-band
 * detectors over Factory's own state (failing runs, …), dedups the results against
 * each project's backlog, and surfaces the survivors as typed proposals. No LLM —
 * these are structured signals, so it's cheap and precise. It shares the dedup +
 * persist/surface seams with the out-of-band synthesis job.
 */
export interface InBandGroomJobDeps {
  cadence: () => Cadence;
  /** Run the in-band detectors → observations (defaults wired in index.ts). */
  detect: () => RawObservation[];
  dedupeAgainstBacklog: DedupeBacklogFn;
  saveObservations: SaveObservationsFn;
}

export function createInBandGroomJob(deps: InBandGroomJobDeps): ScheduledJob {
  return {
    id: "watch-inband-groom",
    cadence: deps.cadence,
    async run() {
      const observations = deps.detect();
      if (observations.length === 0) return;
      const { kept, dropped } = await deps.dedupeAgainstBacklog(observations);
      const { inserted, skipped } = deps.saveObservations(kept);
      console.log(
        `[watch] in-band: ${observations.length} signal(s) → ${inserted} new, ${skipped} dup, ${dropped} already-tracked`,
      );
    },
  };
}
