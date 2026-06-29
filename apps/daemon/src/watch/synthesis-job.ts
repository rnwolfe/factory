import type { Db } from "@factory/db";
import { readAllSettings } from "../settings/store.ts";
import { type Cadence, isCadence, type ScheduledJob } from "../workers/scheduler.ts";
import { type CursorStore, createMemoryCursorStore } from "./cursor-store.ts";
import { availableHarnessSources } from "./sources/registry.ts";
import type { HarnessSource, MemoryDoc, WatchCursor, WorkRecord } from "./sources/types.ts";
import type { RawObservation } from "./synthesize.ts";

/**
 * The out-of-band-work synthesis job (ADR-010 §3). On its operator-tunable
 * cadence it scans every available harness source for new work since last time,
 * synthesizes high-signal observations from it (ingesting a source's existing
 * memory the first time that source is seen), and persists them deduped.
 *
 * Cursors are committed only AFTER synthesis + save succeed, so a failed turn
 * leaves the batch to be re-scanned next cadence (dedup makes that idempotent)
 * rather than silently dropping records. The `synthesize` / `saveObservations`
 * collaborators are injected, keeping this a pure orchestrator.
 */

export type SynthesizeFn = (
  records: WorkRecord[],
  memories: MemoryDoc[],
) => Promise<RawObservation[]>;

export type SaveObservationsFn = (
  obs: RawObservation[],
) => Promise<{ inserted: number; skipped: number }>;

/** Drop proposals already tracked in the target project's backlog (ADR-011 precision). */
export type DedupeBacklogFn = (
  obs: RawObservation[],
) => Promise<{ kept: RawObservation[]; dropped: number }>;

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
  /** Turn scanned work (+ first-seen memories) into observations. */
  synthesize: SynthesizeFn;
  /** Persist observations (deduped); returns insert/skip counts. */
  saveObservations: SaveObservationsFn;
  /**
   * Optional in-band precision pass: drop work proposals already tracked in the
   * target project's backlog before they're persisted/surfaced (ADR-011 §2/"precision
   * over recall"). Defaults to a no-op when absent.
   */
  dedupeAgainstBacklog?: DedupeBacklogFn;
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
      const records: WorkRecord[] = [];
      const memories: MemoryDoc[] = [];
      const pending: WatchCursor[] = []; // committed only after success

      for (const src of sources) {
        try {
          const existing = cursors.get(src.id);
          const cursor =
            existing ??
            ({
              sourceId: src.id,
              position: new Date(Date.now() - lookbackMs).toISOString(),
            } satisfies WatchCursor);
          const scan = await src.scan(cursor);
          records.push(...scan.records);
          pending.push(scan.next);
          // First time we see a source, ingest its existing memory as grounding.
          if (!existing) memories.push(...(await src.readMemories()));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[watch] source ${src.id} scan failed: ${msg}`);
        }
      }

      if (records.length === 0) {
        console.log(`[watch] scanned 0 new work record(s) across ${sources.length} source(s)`);
        return;
      }

      const observations = await deps.synthesize(records, memories);
      // In-band precision pass: never surface work the project already tracks.
      const { kept, dropped } = deps.dedupeAgainstBacklog
        ? await deps.dedupeAgainstBacklog(observations)
        : { kept: observations, dropped: 0 };
      const { inserted, skipped } = await deps.saveObservations(kept);
      // Only now is the work safely synthesized + persisted — advance cursors.
      for (const c of pending) cursors.set(c);
      console.log(
        `[watch] ${records.length} record(s) → ${observations.length} observation(s) ` +
          `(${inserted} new, ${skipped} dup, ${dropped} already-tracked)`,
      );
    },
  };
}
