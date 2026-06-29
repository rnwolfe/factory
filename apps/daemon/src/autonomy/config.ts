import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { readAllSettings } from "../settings/store.ts";
import type { Cadence } from "../workers/scheduler.ts";

/**
 * The unified autonomy POLICY (ADR-016). Resolved through one chain —
 * built-in defaults ⊕ system overrides (the `autonomy-config` setting) ⊕
 * per-project overrides (`projects.autonomyConfig`) — so no feature reads a raw
 * knob. STATE (the Trust-Ladder's earned level) lives separately on the project;
 * this is the configurable policy that governs it.
 */

export type AutonomyEventKind =
  | "trust_promoted"
  | "trust_contracted"
  | "gate_held"
  | "gate_passed"
  | "auto_ran"
  | "auto_merged"
  | "auto_retried"
  | "proposal_surfaced"
  | "freeze_blocked";

export type AlertRoute = "off" | "push" | "digest";
export type VerifierLevel = "none" | "low" | "medium" | "high";
export type BlastCeiling = "contained" | "broad";

export interface AutonomyConfig {
  trust: { autoPromote: boolean; promoteStreak: number; autoContract: boolean };
  gate: { minLevel: VerifierLevel; maxBlastRadius: BlastCeiling; crossModel: boolean };
  watch: { synthesisCadence: Cadence; generatorEnabled: boolean; inbandGroom: boolean };
  autorun: {
    enabled: boolean;
    maxBlastRadius: BlastCeiling;
    /** Proposal kinds eligible to auto-run (allow-list; empty = nothing). */
    classes: string[];
    /** Max auto-runs per project per Watch tick (loop bound). */
    maxPerTick: number;
    /** Code-run auto-run requires the project to have a quality.yaml (fails closed). */
    requireQualityGate: boolean;
    /** System kill-switch — halts ALL auto-run portfolio-wide when true. */
    emergencyStop: boolean;
  };
  retry: {
    /** Auto-resumes of a *transient* blocked/merge failure (reserved; ADR-012 L3). */
    transientBudget: number;
    /** Auto-retries of a gate-held run with an actionable verifier defect, before
     *  it surfaces to the operator. 0 = always surface (today's behavior). */
    verifierBudget: number;
  };
  alerts: Record<AutonomyEventKind, AlertRoute>;
}

/** Built-in defaults — reproduce today's behavior exactly (no-op until overridden). */
export const BUILTIN_AUTONOMY: AutonomyConfig = {
  trust: { autoPromote: true, promoteStreak: 5, autoContract: true },
  gate: { minLevel: "high", maxBlastRadius: "contained", crossModel: true },
  watch: { synthesisCadence: "daily", generatorEnabled: true, inbandGroom: true },
  autorun: {
    enabled: false,
    maxBlastRadius: "contained",
    classes: [],
    maxPerTick: 1,
    requireQualityGate: true,
    emergencyStop: false,
  },
  retry: { transientBudget: 1, verifierBudget: 2 },
  // Resolution: loud on risk, digest the rest (ADR-016 §3).
  alerts: {
    trust_contracted: "push",
    auto_merged: "push",
    auto_ran: "push",
    proposal_surfaced: "push",
    trust_promoted: "digest",
    gate_held: "digest",
    gate_passed: "digest",
    auto_retried: "digest",
    freeze_blocked: "digest",
  },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** A partial override blob (what system/project store + what a preset is). */
export type AutonomyOverride = DeepPartial<AutonomyConfig>;

export type AutonomyPreset = "conservative" | "balanced" | "hands-off";

/**
 * Operator-facing bundles (ADR-016 §4) — pick one instead of touching ~10 knobs.
 * Each is an override blob applied at the chosen scope; "Advanced" then tweaks
 * individual knobs over the preset.
 */
export const AUTONOMY_PRESETS: Record<AutonomyPreset, AutonomyOverride> = {
  // Everything gated, nothing self-promotes, alerts loud.
  conservative: {
    trust: { autoPromote: false, autoContract: true },
    autorun: { enabled: false },
    alerts: { trust_promoted: "push", gate_held: "push", gate_passed: "push" },
  },
  // The defaults: earn promotion, gate auto-merge, no auto-run.
  balanced: {
    trust: { autoPromote: true, promoteStreak: 5, autoContract: true },
    autorun: { enabled: false },
  },
  // Promote faster and let the smallest-blast-radius work auto-run (still gated).
  "hands-off": {
    trust: { autoPromote: true, promoteStreak: 3, autoContract: true },
    autorun: { enabled: true, maxBlastRadius: "contained" },
  },
};

function merge(base: AutonomyConfig, over: DeepPartial<AutonomyConfig> | null): AutonomyConfig {
  if (!over) return base;
  return {
    trust: { ...base.trust, ...over.trust },
    gate: { ...base.gate, ...over.gate },
    watch: { ...base.watch, ...over.watch },
    autorun: {
      ...base.autorun,
      ...over.autorun,
      // arrays replace, not merge (and coerce — DeepPartial loosens elements)
      classes: (over.autorun?.classes ?? base.autorun.classes).filter(
        (c): c is string => typeof c === "string",
      ),
    },
    retry: { ...base.retry, ...over.retry },
    alerts: { ...base.alerts, ...over.alerts },
  };
}

function parsePartial(raw: string | null | undefined): DeepPartial<AutonomyConfig> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as DeepPartial<AutonomyConfig>) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective policy for a project (or the system default when no
 * projectId): built-in ⊕ system ⊕ project. The single read path for every knob.
 */
export function resolveAutonomyConfig(db: Db, projectId?: string | null): AutonomyConfig {
  const systemRaw = readAllSettings(db).get("autonomy-config");
  let cfg = merge(BUILTIN_AUTONOMY, parsePartial(systemRaw));
  if (projectId) {
    const row = db
      .select({ ac: schema.projects.autonomyConfig })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    cfg = merge(cfg, parsePartial(row?.ac));
  }
  return cfg;
}
