/**
 * AutonomyPanel — the operator surface for the unified autonomy POLICY (ADR-016).
 *
 * One reusable panel mounted at two scopes:
 *   - system  (Settings → autonomy)        — overrides built-in defaults
 *   - project (Project page → autonomy tab) — overrides system, per project
 *
 * Design constraint (ADR-016): the policy is ~10 knobs. Scattering them across
 * the already-busy settings/project pages would drown the operator, so this is
 * PRESET-FIRST with progressive disclosure:
 *   1. Preset row    — Conservative / Balanced / Hands-off (one tap).
 *   2. Summary       — the resolved (effective) policy, dense + mono.
 *   3. Advanced      — every knob, editable, behind a disclosure.
 *
 * The project panel is INHERITANCE-AWARE: each knob shows whether its value is
 * inherited (from system / built-in) or overridden on the project, with the
 * inherited value surfaced and a one-click revert that drops the key from the
 * project's override blob.
 *
 * Writes go through `autonomy.setSystem` / `autonomy.setProject` / `applyPreset`
 * and refetch `autonomy.config`. Types are inferred from the tRPC client so the
 * panel stays in lockstep with the daemon router.
 */

import type { AppRouter } from "@factory/daemon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterInputs } from "@trpc/server";
import { Activity, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

// ── types (inferred from the tRPC client; lockstep with the router) ───────────

export type AutonomyConfigResponse = Awaited<ReturnType<typeof trpc.autonomy.config.query>>;
export type AutonomyConfig = AutonomyConfigResponse["resolved"];
/**
 * A partial override blob — the shape stored per scope. Derived from the
 * mutation INPUT (not the query output) so what we build here is exactly what
 * `setSystem` / `setProject` accept (e.g. `autorun.classes: string[]`).
 */
export type AutonomyOverride = NonNullable<
  inferRouterInputs<AppRouter>["autonomy"]["setProject"]["override"]
>;
export type AutonomyPreset = "conservative" | "balanced" | "hands-off";
export type AutonomyHistoryRow = Awaited<ReturnType<typeof trpc.autonomy.history.query>>[number];

type Scope = "system" | "project";
type AlertRoute = "off" | "push" | "digest";

const PRESETS: readonly AutonomyPreset[] = ["conservative", "balanced", "hands-off"] as const;
const PRESET_BLURB: Record<AutonomyPreset, string> = {
  conservative: "everything gated · nothing self-promotes · alerts loud",
  balanced: "earn promotion · gate auto-merge · no auto-run (the defaults)",
  "hands-off": "promote faster · smallest-blast work auto-runs (still gated)",
};

const ALERT_KINDS: readonly string[] = [
  "trust_promoted",
  "trust_contracted",
  "gate_held",
  "gate_passed",
  "auto_ran",
  "auto_merged",
  "auto_retried",
  "proposal_surfaced",
  "freeze_blocked",
];

// ── pure helpers ──────────────────────────────────────────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Mirror of the daemon's merge — built-in/system ⊕ override, for inheritance display. */
function mergeConfig(
  base: AutonomyConfig,
  over: AutonomyOverride | null | undefined,
): AutonomyConfig {
  if (!over) return base;
  return {
    trust: { ...base.trust, ...over.trust },
    gate: { ...base.gate, ...over.gate },
    watch: { ...base.watch, ...over.watch },
    autorun: {
      ...base.autorun,
      ...over.autorun,
      classes: (over.autorun?.classes ?? base.autorun.classes).filter(
        (c): c is string => typeof c === "string",
      ),
    },
    retry: { ...base.retry, ...over.retry },
    alerts: { ...base.alerts, ...over.alerts },
  };
}

/** Drop empty groups so a blank override clears cleanly (null at project scope). */
function prune(over: AutonomyOverride): AutonomyOverride | null {
  const next: AutonomyOverride = {};
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    (next as Record<string, unknown>)[k] = v;
  }
  return Object.keys(next).length === 0 ? null : next;
}

function matchingPreset(
  over: AutonomyOverride | null,
  presets: AutonomyConfigResponse["presets"],
): AutonomyPreset | null {
  if (!over) return null;
  for (const p of PRESETS) {
    if (deepEqual(over, presets[p])) return p;
  }
  return null;
}

// ── relative-time (mirrors ops.tsx; no shared lib helper) ─────────────────────

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── data wrapper ──────────────────────────────────────────────────────────────

export function AutonomyPanel({ scope, projectId }: { scope: Scope; projectId?: string }) {
  const qc = useQueryClient();
  const key = ["autonomy.config", scope, projectId ?? ""] as const;
  const cfg = useQuery({
    queryKey: key,
    queryFn: () => trpc.autonomy.config.query(projectId ? { projectId } : undefined),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const applyPreset = useMutation({
    mutationFn: (preset: AutonomyPreset) =>
      trpc.autonomy.applyPreset.mutate({ scope, projectId, preset }),
    onSuccess: invalidate,
  });

  const save = useMutation({
    mutationFn: (next: AutonomyOverride | null) =>
      scope === "system"
        ? trpc.autonomy.setSystem.mutate({ override: next ?? {} })
        : trpc.autonomy.setProject.mutate({ projectId: projectId ?? "", override: next }),
    onSuccess: invalidate,
  });

  const pending = applyPreset.isPending || save.isPending;

  return (
    <AutonomyPanelView
      scope={scope}
      data={cfg.data}
      isLoading={cfg.isLoading}
      pending={pending}
      onApplyPreset={(p) => applyPreset.mutate(p)}
      onSaveOverride={(next) => save.mutate(next)}
      error={(applyPreset.error ?? save.error) as Error | null}
    />
  );
}

// ── presentational view (prop-driven, no network — render-testable) ───────────

export interface AutonomyPanelViewProps {
  scope: Scope;
  data: AutonomyConfigResponse | undefined;
  isLoading?: boolean;
  pending?: boolean;
  onApplyPreset: (preset: AutonomyPreset) => void;
  onSaveOverride: (next: AutonomyOverride | null) => void;
  error?: Error | null;
}

export function AutonomyPanelView({
  scope,
  data,
  isLoading,
  pending,
  onApplyPreset,
  onSaveOverride,
  error,
}: AutonomyPanelViewProps) {
  const [advanced, setAdvanced] = useState(false);

  if (isLoading || !data) {
    return (
      <div className="surface p-4">
        <div className="skel h-5 w-40 mb-3" />
        <div className="skel h-20 w-full" />
      </div>
    );
  }

  // The query returns overrides as a DeepPartial; cast to the input-shaped
  // override type (same JSON at runtime) so edits round-trip back to setX.
  const override = ((scope === "system" ? data.systemOverride : data.projectOverride) ??
    null) as unknown as AutonomyOverride | null;
  // The policy in effect were this scope's override removed — used to show the
  // value each knob would inherit. System inherits built-in; project inherits
  // built-in ⊕ system.
  const inheritedConfig =
    scope === "system"
      ? data.builtin
      : mergeConfig(data.builtin, data.systemOverride as unknown as AutonomyOverride | null);
  const activePreset = matchingPreset(override, data.presets);
  const isCustom = override != null && activePreset == null;

  // A knob edit clones the current override, mutates the path, prunes empties,
  // and saves the resulting blob (null clears the scope back to pure inheritance).
  const edit = (mutate: (draft: AutonomyOverride) => void) => {
    const draft = override ? clone(override) : {};
    mutate(draft);
    onSaveOverride(prune(draft));
  };

  const ctx: KnobCtx = {
    scope,
    resolved: data.resolved,
    inherited: inheritedConfig,
    override,
    pending: pending ?? false,
    edit,
  };

  return (
    <div className="space-y-4">
      {/* 1 — preset row */}
      <section className="surface p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            preset
          </span>
          <div className="hairline flex-1" />
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {activePreset ? (
              <span className="text-[var(--color-accent)]">{activePreset}</span>
            ) : isCustom ? (
              "custom"
            ) : (
              "inherited"
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onApplyPreset(p)}
              disabled={pending}
              className={`chip ${activePreset === p ? "chip-accent" : "hover:border-[var(--color-line-bright)]"}`}
            >
              {p}
            </button>
          ))}
          {pending ? (
            <Loader2 size={12} className="animate-spin text-[var(--color-fg-3)] self-center ml-1" />
          ) : null}
        </div>
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2 leading-relaxed">
          {activePreset
            ? PRESET_BLURB[activePreset]
            : scope === "project"
              ? "pick a preset, or leave inherited to follow the system policy"
              : "pick a preset, or leave inherited to follow the built-in defaults"}
        </p>
        {error ? (
          <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
            {error.message}
          </div>
        ) : null}
      </section>

      {/* 2 — resolved summary */}
      <ResolvedSummary cfg={data.resolved} />

      {/* 3 — advanced disclosure */}
      <section className="surface">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="w-full px-3 py-2.5 flex items-center justify-between active:bg-[var(--color-bg-2)]"
        >
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            advanced · every knob
          </span>
          <ChevronRight
            size={14}
            className={`text-[var(--color-fg-3)] transition-transform ${advanced ? "rotate-90" : ""}`}
          />
        </button>

        {advanced ? (
          <div className="border-t border-[var(--color-line)]">
            <KnobGroup title="trust · the ladder">
              <BoolKnob
                ctx={ctx}
                label="auto-promote"
                get={(c) => c.trust.autoPromote}
                set={(d, v) => setIn(d, "trust", "autoPromote", v)}
                drop={(d) => dropIn(d, "trust", "autoPromote")}
              />
              <NumberKnob
                ctx={ctx}
                label="promote streak"
                min={1}
                max={50}
                get={(c) => c.trust.promoteStreak}
                set={(d, v) => setIn(d, "trust", "promoteStreak", v)}
                drop={(d) => dropIn(d, "trust", "promoteStreak")}
              />
              <BoolKnob
                ctx={ctx}
                label="auto-contract"
                get={(c) => c.trust.autoContract}
                set={(d, v) => setIn(d, "trust", "autoContract", v)}
                drop={(d) => dropIn(d, "trust", "autoContract")}
              />
            </KnobGroup>

            <KnobGroup title="gate · auto-merge">
              <SelectKnob
                ctx={ctx}
                label="min level"
                options={["none", "low", "medium", "high"]}
                get={(c) => c.gate.minLevel}
                set={(d, v) => setIn(d, "gate", "minLevel", v)}
                drop={(d) => dropIn(d, "gate", "minLevel")}
              />
              <SelectKnob
                ctx={ctx}
                label="max blast radius"
                options={["contained", "broad"]}
                get={(c) => c.gate.maxBlastRadius}
                set={(d, v) => setIn(d, "gate", "maxBlastRadius", v)}
                drop={(d) => dropIn(d, "gate", "maxBlastRadius")}
              />
              <BoolKnob
                ctx={ctx}
                label="cross-model"
                get={(c) => c.gate.crossModel}
                set={(d, v) => setIn(d, "gate", "crossModel", v)}
                drop={(d) => dropIn(d, "gate", "crossModel")}
              />
            </KnobGroup>

            <KnobGroup title="watch · synthesis">
              <SelectKnob
                ctx={ctx}
                label="cadence"
                options={["off", "hourly", "daily", "weekly"]}
                get={(c) => c.watch.synthesisCadence}
                set={(d, v) => setIn(d, "watch", "synthesisCadence", v)}
                drop={(d) => dropIn(d, "watch", "synthesisCadence")}
              />
              <BoolKnob
                ctx={ctx}
                label="generator"
                get={(c) => c.watch.generatorEnabled}
                set={(d, v) => setIn(d, "watch", "generatorEnabled", v)}
                drop={(d) => dropIn(d, "watch", "generatorEnabled")}
              />
              <BoolKnob
                ctx={ctx}
                label="in-band groom"
                get={(c) => c.watch.inbandGroom}
                set={(d, v) => setIn(d, "watch", "inbandGroom", v)}
                drop={(d) => dropIn(d, "watch", "inbandGroom")}
              />
            </KnobGroup>

            <KnobGroup title="autorun">
              <BoolKnob
                ctx={ctx}
                label="enabled"
                get={(c) => c.autorun.enabled}
                set={(d, v) => setIn(d, "autorun", "enabled", v)}
                drop={(d) => dropIn(d, "autorun", "enabled")}
              />
              <SelectKnob
                ctx={ctx}
                label="max blast radius"
                options={["contained", "broad"]}
                get={(c) => c.autorun.maxBlastRadius}
                set={(d, v) => setIn(d, "autorun", "maxBlastRadius", v)}
                drop={(d) => dropIn(d, "autorun", "maxBlastRadius")}
              />
              <ClassesKnob ctx={ctx} />
            </KnobGroup>

            <KnobGroup title="retry">
              <NumberKnob
                ctx={ctx}
                label="transient budget"
                min={0}
                max={10}
                get={(c) => c.retry.transientBudget}
                set={(d, v) => setIn(d, "retry", "transientBudget", v)}
                drop={(d) => dropIn(d, "retry", "transientBudget")}
              />
            </KnobGroup>

            <KnobGroup title="alerts · per event">
              <AlertMatrix ctx={ctx} />
            </KnobGroup>
          </div>
        ) : null}
      </section>

      <p className="mono text-[9.5px] text-[var(--color-fg-3)] px-1 leading-relaxed">
        {scope === "project"
          ? "project policy overrides system; each knob shows whether it's inherited or overridden here."
          : "system policy overrides the built-in defaults for every project."}
      </p>
    </div>
  );
}

// ── resolved summary ──────────────────────────────────────────────────────────

function onOff(v: boolean): string {
  return v ? "on" : "off";
}

function ResolvedSummary({ cfg }: { cfg: AutonomyConfig }) {
  const alertCounts = ALERT_KINDS.reduce(
    (acc, k) => {
      const r = (cfg.alerts as Record<string, AlertRoute>)[k] ?? "off";
      acc[r] += 1;
      return acc;
    },
    { off: 0, push: 0, digest: 0 } as Record<AlertRoute, number>,
  );
  const rows: Array<[string, string]> = [
    [
      "trust",
      `auto-promote ${onOff(cfg.trust.autoPromote)} · streak ${cfg.trust.promoteStreak} · auto-contract ${onOff(cfg.trust.autoContract)}`,
    ],
    [
      "gate",
      `min ${cfg.gate.minLevel} · blast ${cfg.gate.maxBlastRadius} · cross-model ${onOff(cfg.gate.crossModel)}`,
    ],
    [
      "watch",
      `synthesis ${cfg.watch.synthesisCadence} · generator ${onOff(cfg.watch.generatorEnabled)} · groom ${onOff(cfg.watch.inbandGroom)}`,
    ],
    [
      "autorun",
      `${onOff(cfg.autorun.enabled)} · blast ${cfg.autorun.maxBlastRadius} · classes ${cfg.autorun.classes.length > 0 ? cfg.autorun.classes.join(", ") : "—"}`,
    ],
    ["retry", `transient budget ${cfg.retry.transientBudget}`],
    ["alerts", `push ${alertCounts.push} · digest ${alertCounts.digest} · off ${alertCounts.off}`],
  ];
  return (
    <section className="surface p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          effective policy
        </span>
        <div className="hairline flex-1" />
      </div>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2 items-baseline">
            <dt className="mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-3)] w-[58px] shrink-0">
              {k}
            </dt>
            <dd className="mono text-[11.5px] text-[var(--color-fg-1)] leading-snug">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── knob plumbing ─────────────────────────────────────────────────────────────

interface KnobCtx {
  scope: Scope;
  resolved: AutonomyConfig;
  inherited: AutonomyConfig;
  override: AutonomyOverride | null;
  pending: boolean;
  edit: (mutate: (draft: AutonomyOverride) => void) => void;
}

type Group = "trust" | "gate" | "watch" | "autorun" | "retry";

function setIn(draft: AutonomyOverride, group: Group, key: string, value: unknown) {
  const d = draft as Record<string, Record<string, unknown>>;
  if (!d[group]) d[group] = {};
  d[group][key] = value;
}

function dropIn(draft: AutonomyOverride, group: Group, key: string) {
  const g = (draft as Record<string, Record<string, unknown> | undefined>)[group];
  if (g) delete g[key];
}

/** Is a given override path explicitly set on this scope? */
function isOverridden(over: AutonomyOverride | null, group: string, key: string): boolean {
  if (!over) return false;
  const g = (over as Record<string, Record<string, unknown> | undefined>)[group];
  return g != null && Object.hasOwn(g, key);
}

function KnobGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--color-line)] last:border-b-0">
      <div className="px-3 pt-2.5 pb-1 mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-3)]">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

/**
 * Common chrome for one knob: label, inherited/override tag (inheritance-aware),
 * the editable control, and a revert-to-inherited affordance when overridden.
 */
function KnobShell({
  ctx,
  group,
  knobKey,
  label,
  inheritedLabel,
  drop,
  children,
}: {
  ctx: KnobCtx;
  group: string;
  knobKey: string;
  label: string;
  inheritedLabel: string;
  drop: (draft: AutonomyOverride) => void;
  children: React.ReactNode;
}) {
  const overridden = isOverridden(ctx.override, group, knobKey);
  return (
    <div className="px-3 py-2 border-t border-[var(--color-line)] first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] text-[var(--color-fg-1)] truncate">{label}</span>
          {overridden ? (
            <span className="chip chip-accent text-[9px]">override</span>
          ) : (
            <span className="chip text-[9px] text-[var(--color-fg-3)]">inherited</span>
          )}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {overridden ? (
        <div className="flex items-center gap-2 mt-1">
          <span className="mono text-[10px] text-[var(--color-fg-3)]">
            inherits <span className="text-[var(--color-fg-2)]">{inheritedLabel}</span>
          </span>
          <button
            type="button"
            onClick={() => ctx.edit(drop)}
            disabled={ctx.pending}
            className="mono text-[10px] text-[var(--color-accent)] inline-flex items-center gap-1 hover:underline"
          >
            <RotateCcw size={9} />
            revert
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BoolKnob({
  ctx,
  label,
  get,
  set,
  drop,
}: {
  ctx: KnobCtx;
  label: string;
  get: (c: AutonomyConfig) => boolean;
  set: (draft: AutonomyOverride, v: boolean) => void;
  drop: (draft: AutonomyOverride) => void;
}) {
  const [group, knobKey] = parseSetter(set);
  const value = get(ctx.resolved);
  return (
    <KnobShell
      ctx={ctx}
      group={group}
      knobKey={knobKey}
      label={label}
      inheritedLabel={onOff(get(ctx.inherited))}
      drop={drop}
    >
      <div className="flex gap-1">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            onClick={() => ctx.edit((d) => set(d, on))}
            disabled={ctx.pending}
            className={`chip text-[10.5px] ${value === on ? "chip-accent" : ""}`}
          >
            {on ? "on" : "off"}
          </button>
        ))}
      </div>
    </KnobShell>
  );
}

function NumberKnob({
  ctx,
  label,
  min,
  max,
  get,
  set,
  drop,
}: {
  ctx: KnobCtx;
  label: string;
  min: number;
  max: number;
  get: (c: AutonomyConfig) => number;
  set: (draft: AutonomyOverride, v: number) => void;
  drop: (draft: AutonomyOverride) => void;
}) {
  const [group, knobKey] = parseSetter(set);
  return (
    <KnobShell
      ctx={ctx}
      group={group}
      knobKey={knobKey}
      label={label}
      inheritedLabel={String(get(ctx.inherited))}
      drop={drop}
    >
      <input
        type="number"
        min={min}
        max={max}
        value={get(ctx.resolved)}
        disabled={ctx.pending}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isNaN(n)) return;
          ctx.edit((d) => set(d, Math.max(min, Math.min(max, n))));
        }}
        className="w-16 mono text-[12px] tabular-nums bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1 text-right"
      />
    </KnobShell>
  );
}

function SelectKnob({
  ctx,
  label,
  options,
  get,
  set,
  drop,
}: {
  ctx: KnobCtx;
  label: string;
  options: readonly string[];
  get: (c: AutonomyConfig) => string;
  set: (draft: AutonomyOverride, v: string) => void;
  drop: (draft: AutonomyOverride) => void;
}) {
  const [group, knobKey] = parseSetter(set);
  return (
    <KnobShell
      ctx={ctx}
      group={group}
      knobKey={knobKey}
      label={label}
      inheritedLabel={get(ctx.inherited)}
      drop={drop}
    >
      <select
        value={get(ctx.resolved)}
        disabled={ctx.pending}
        onChange={(e) => ctx.edit((d) => set(d, e.target.value))}
        className="mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </KnobShell>
  );
}

function ClassesKnob({ ctx }: { ctx: KnobCtx }) {
  const overridden = isOverridden(ctx.override, "autorun", "classes");
  const value = ctx.resolved.autorun.classes;
  const inherited = ctx.inherited.autorun.classes;
  return (
    <KnobShell
      ctx={ctx}
      group="autorun"
      knobKey="classes"
      label="auto-run classes"
      inheritedLabel={inherited.length > 0 ? inherited.join(", ") : "—"}
      drop={(d) => dropIn(d, "autorun", "classes")}
    >
      <input
        type="text"
        defaultValue={value.join(", ")}
        disabled={ctx.pending}
        placeholder="comma-separated"
        onBlur={(e) => {
          const next = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (deepEqual(next, value)) return;
          ctx.edit((d) => setIn(d, "autorun", "classes", next));
        }}
        className="w-40 mono text-[11.5px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
      />
      {!overridden ? <span className="sr-only">inherited</span> : null}
    </KnobShell>
  );
}

const ALERT_ROUTES: readonly AlertRoute[] = ["off", "push", "digest"] as const;

function AlertMatrix({ ctx }: { ctx: KnobCtx }) {
  const resolved = ctx.resolved.alerts as Record<string, AlertRoute>;
  const inherited = ctx.inherited.alerts as Record<string, AlertRoute>;
  const overAlerts = (ctx.override?.alerts ?? {}) as Record<string, AlertRoute>;
  return (
    <div className="px-3 py-1">
      {ALERT_KINDS.map((kind) => {
        const overridden = Object.hasOwn(overAlerts, kind);
        const current = resolved[kind] ?? "off";
        return (
          <div
            key={kind}
            className="flex items-center justify-between gap-2 py-1.5 border-t border-[var(--color-line)] first:border-t-0"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="mono text-[11px] text-[var(--color-fg-1)] truncate">{kind}</span>
              {overridden ? (
                <span className="chip chip-accent text-[9px]">override</span>
              ) : (
                <span className="chip text-[9px] text-[var(--color-fg-3)]">
                  {inherited[kind] ?? "off"}
                </span>
              )}
            </div>
            <div className="flex gap-1 shrink-0">
              {ALERT_ROUTES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() =>
                    ctx.edit((d) => {
                      const dd = d as Record<string, Record<string, unknown>>;
                      if (!dd.alerts) dd.alerts = {};
                      dd.alerts[kind] = r;
                    })
                  }
                  disabled={ctx.pending}
                  className={`chip text-[10px] ${current === r ? "chip-accent" : ""}`}
                >
                  {r}
                </button>
              ))}
              {overridden ? (
                <button
                  type="button"
                  aria-label={`revert ${kind} alert`}
                  onClick={() =>
                    ctx.edit((d) => {
                      const a = (d as Record<string, Record<string, unknown> | undefined>).alerts;
                      if (a) delete a[kind];
                    })
                  }
                  disabled={ctx.pending}
                  className="mono text-[10px] text-[var(--color-accent)] inline-flex items-center self-center hover:underline"
                >
                  <RotateCcw size={9} />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Recover [group, key] from a typed setter by probing it against an empty draft.
 * Keeps the knob call-sites a single line each without threading group/key
 * tuples through every component.
 */
function parseSetter(set: (draft: AutonomyOverride, v: never) => void): [Group, string] {
  const probe: Record<string, Record<string, unknown>> = {};
  set(probe as AutonomyOverride, undefined as never);
  const group = Object.keys(probe)[0] as Group;
  const inner = probe[group] ?? {};
  const key = Object.keys(inner)[0] ?? "";
  return [group, key];
}

// ── /ops history surface ──────────────────────────────────────────────────────

const EVENT_CHIP: Record<string, string> = {
  trust_promoted: "chip-greenlit",
  gate_passed: "chip-greenlit",
  auto_merged: "chip-greenlit",
  auto_ran: "chip-accent",
  auto_retried: "chip-accent",
  proposal_surfaced: "chip-decompose",
  trust_contracted: "chip-trashed",
  gate_held: "chip-trashed",
  freeze_blocked: "chip-trashed",
};

/**
 * Read-only timeline of what the autonomy machinery did unattended (ADR-016 §3).
 * Lives on /ops as an awareness surface — never an action queue.
 */
export function AutonomyHistory({ limit = 50 }: { limit?: number }) {
  const hist = useQuery({
    queryKey: ["autonomy.history", limit],
    queryFn: () => trpc.autonomy.history.query({ limit }),
    refetchInterval: 60_000,
  });
  return <AutonomyHistoryView rows={hist.data} isLoading={hist.isLoading} />;
}

export function AutonomyHistoryView({
  rows,
  isLoading,
}: {
  rows: AutonomyHistoryRow[] | undefined;
  isLoading?: boolean;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <Activity size={12} className="text-[var(--color-accent)]" />
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          autonomy · unattended
        </span>
        <div className="hairline flex-1" />
        {rows ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{rows.length}</span>
        ) : null}
      </div>
      {isLoading ? (
        <div className="surface p-3">
          <div className="skel h-3 w-2/3 mb-1.5" />
          <div className="skel h-3 w-1/2" />
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">
          nothing autonomous yet — the system hasn't acted unattended.
        </p>
      ) : (
        <div className="surface divide-y divide-[var(--color-line)]">
          {rows.map((e) => (
            <div key={e.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className={`chip shrink-0 ${EVENT_CHIP[e.kind] ?? ""}`.trim()}>{e.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-[var(--color-fg-1)] leading-snug">{e.message}</div>
                <div className="mono text-[10px] text-[var(--color-fg-3)] mt-0.5 flex items-center gap-2 flex-wrap">
                  {e.projectId ? (
                    <Link
                      to={`/projects/${e.projectId}`}
                      className="text-[var(--color-accent)] hover:underline"
                    >
                      project
                    </Link>
                  ) : (
                    <span>system</span>
                  )}
                  {e.runId ? <span>· run {e.runId.slice(0, 8)}</span> : null}
                </div>
              </div>
              <span className="mono text-[10px] text-[var(--color-fg-3)] shrink-0">
                {fmtAgo(e.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
