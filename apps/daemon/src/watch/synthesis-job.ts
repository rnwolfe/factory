import type { Db } from "@factory/db";
import { readAllSettings } from "../settings/store.ts";
import { type Cadence, isCadence, type ScheduledJob } from "../workers/scheduler.ts";
import { type CursorStore, createMemoryCursorStore } from "./cursor-store.ts";
import { availableHarnessSources } from "./sources/registry.ts";
import type { HarnessSource, WatchCursor } from "./sources/types.ts";

/**
 * The out-of-band-work synthesis job (ADR-010 §3). On its operator-tunable
 * cadence it scans every available harness source for new work since last time.
 *
 * SLICE 2 scope: scan + advance an in-memory cursor + report volume. The
 * token-intensive synthesis — feeding `WorkRecord`s + `readMemories()` to a
 * `claude --print` pass → `watch_insight` inbox items, and persisting cursors in
 * `watch_cursors` — lands in slice 3. The cadence knob already governs it now,
 * so the operator can dial spend before the tokens start flowing.
 */

const DEFAULT_CADENCE: Cadence = "daily";

/**
 * The synthesis cadence, read live from the `watch-synthesis-cadence` setting
 * (`off | hourly | daily | weekly`), defaulting to daily. Read per-tick so a
 * settings change takes effect without a restart.
 */
export function readWatchSynthesisCadence(db: Db): Cadence {
  const v = readAllSettings(db).get("watch-synthesis-cadence");
  return v && isCadence(v) ? v : DEFAULT_CADENCE;
}

export interface SynthesisJobDeps {
  cadence: () => Cadence;
  /** Injectable for tests; defaults to the registry's available sources. */
  listSources?: () => Promise<HarnessSource[]>;
  /**
   * How far back the first (cursorless) scan of each source looks, bounding the
   * cold-start cost. Once a durable cursor exists this is a one-time floor.
   */
  initialLookbackDays?: number;
  /** Durable scan positions; defaults to a non-durable in-memory store. */
  cursors?: CursorStore;
}

export function createSynthesisJob(deps: SynthesisJobDeps): ScheduledJob {
  const listSources = deps.listSources ?? availableHarnessSources;
  const lookbackMs = (deps.initialLookbackDays ?? 7) * 24 * 60 * 60_000;
  const cursors = deps.cursors ?? createMemoryCursorStore();

  return {
    id: "watch-synthesis",
    cadence: deps.cadence,
    async run() {
      const sources = await listSources();
      let scanned = 0;
      for (const src of sources) {
        try {
          const cursor =
            cursors.get(src.id) ??
            ({
              sourceId: src.id,
              position: new Date(Date.now() - lookbackMs).toISOString(),
            } satisfies WatchCursor);
          const { records, next } = await src.scan(cursor);
          cursors.set(next);
          scanned += records.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[watch] source ${src.id} scan failed: ${msg}`);
        }
      }
      // Slice 3: synthesize the scanned work (+ readMemories) into observations.
      console.log(
        `[watch] scanned ${scanned} new work record(s) across ${sources.length} source(s)`,
      );
    },
  };
}
