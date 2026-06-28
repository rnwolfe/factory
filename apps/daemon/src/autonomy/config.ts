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
  autorun: { enabled: boolean; maxBlastRadius: BlastCeiling; classes: string[] };
  retry: { transientBudget: number };
  alerts: Record<AutonomyEventKind, AlertRoute>;
}

/** Built-in defaults — reproduce today's behavior exactly (no-op until overridden). */
export const BUILTIN_AUTONOMY: AutonomyConfig = {
  trust: { autoPromote: true, promoteStreak: 5, autoContract: true },
  gate: { minLevel: "high", maxBlastRadius: "contained", crossModel: true },
  watch: { synthesisCadence: "daily", generatorEnabled: true, inbandGroom: true },
  autorun: { enabled: false, maxBlastRadius: "contained", classes: [] },
  retry: { transientBudget: 1 },
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
