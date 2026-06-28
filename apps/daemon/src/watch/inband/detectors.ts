import type { Db } from "@factory/db";
import type { RawObservation } from "../synthesize.ts";
import { detectRunFailureSignals } from "./run-health.ts";

/**
 * In-band signal detectors (ADR-011 §2). Each reads Factory's own state and emits
 * typed observations deterministically (no LLM). Registry discipline: adding a
 * detector is one entry here; the groom job iterates — it never branches on id.
 */
export type InBandDetector = (db: Db) => RawObservation[];

export const IN_BAND_DETECTORS: ReadonlyArray<{ id: string; detect: InBandDetector }> = [
  { id: "run-failures", detect: detectRunFailureSignals },
];

/** Run every detector, isolating failures so one bad detector can't sink the rest. */
export function runInBandDetectors(db: Db): RawObservation[] {
  const out: RawObservation[] = [];
  for (const d of IN_BAND_DETECTORS) {
    try {
      out.push(...d.detect(db));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[watch] in-band detector ${d.id} failed: ${msg}`);
    }
  }
  return out;
}
