# ADR-016 · Autonomy: configuration, observability, and alerting

**Status:** proposed (2026-06-28) — **draft for operator review**
**Scope:** the connective tissue for the autonomy initiative. Frames the remaining
build (ADR-011 Phase C auto-run, ADR-012 Slice 2 surfacing + Slice 3 auto-retry) and
makes every autonomy behavior **configurable (system + per-project), observable, and
alertable** — without overloading the settings or project pages.
**Builds on:** ADR-010 (Watch), 011 (Watch generator), 012 (Trust Ladder), 013 (metrics),
014 (Verifier gate).

## Context

The autonomy features now exist (Watch generator, verifier-coverage gate, Trust Ladder
auto-movement). But the connective tissue is missing or ad-hoc:

1. **Config is scattered and one-scope.** `autonomyMode` is a project column; the Watch
   cadence is a system setting; cross-model is hardcoded to autonomous; the promote-streak
   and gate thresholds are constants. There's **no system default + per-project override**
   pattern — every knob lives at one scope, the wrong one for half the cases.
2. **Autonomy is invisible.** When the system acts unattended — a Trust-Ladder contraction,
   a gate-hold, (soon) an auto-run — it `console.log`s. The operator, who is by definition
   *out of the loop* in autonomous mode, has no awareness channel and no history.
3. **The remaining pieces need a home.** Phase C (auto-run) and Slice 3 (auto-retry) each
   introduce more knobs and more unattended actions — they must not each invent their own
   config + logging.
4. **The UI is already full.** Settings is an 11-section flat list; the project page is
   dense. Naively adding ~10 autonomy knobs × 2 scopes would wreck both.

## Decision

Three pillars + an IA discipline.

### 1. One autonomy config, resolved system → project → built-in

Separate **state** from **policy**:

- **Autonomy STATE** = the Trust-Ladder's current level (`autonomyMode` today). It *moves
  itself* (ADR-012) and stays a project column — it is not "configured," it is *earned*.
- **Autonomy POLICY** = the knobs. A typed `AutonomyConfig` resolved through a chain:
  **built-in defaults (code) ⊕ system defaults (settings) ⊕ per-project overrides**. Only
  *set* keys override; everything else inherits. One resolver (`resolveAutonomyConfig(db,
  projectId?)`) is the single read path; nothing reads a raw knob.

Storage mirrors the lesson from the task-backend `backendConfig` blob (ADR-015): a partial
**`projects.autonomyConfig` JSON** for overrides (no column-per-knob explosion) + system
defaults as settings keys. The knob catalog (initial):

| Knob | Default | Scope |
|---|---|---|
| `trust.autoPromote` (on/off) · `trust.promoteStreak` (N=5) · `trust.autoContract` | on / 5 / on | sys+proj |
| `gate.minLevel` (high) · `gate.maxBlastRadius` (contained) · `gate.crossModel` (on for autonomous) | high / contained / on | sys+proj |
| `watch.synthesisCadence` · `watch.generatorEnabled` · `watch.inbandGroom` | daily / on / on | sys+proj |
| `autorun.enabled` (Phase C) · `autorun.maxBlastRadius` · `autorun.classes` (which proposal kinds) | **off** / contained / none | sys+proj |
| `retry.transientBudget` (Slice 3) | 1 | sys+proj |
| `alerts.<event> ∈ {off, push, digest}` | see §3 | sys+proj |

### 2. An autonomy event log — rich tracking, one source

A new `autonomy_events` table: `{id, projectId, runId?, kind, detail(JSON), createdAt}`.
**Every** unattended autonomy action writes one row: `trust_promoted`, `trust_contracted`,
`gate_held`, `gate_passed`, `auto_ran`, `auto_merged`, `auto_retried`, `proposal_surfaced`,
`freeze_blocked`. This single log powers three consumers so none reinvents it:
- **History** — a queryable "what the system did unattended" timeline (per-project + portfolio).
- **Metrics** — the ADR-013 catalog gains autonomy-event counts (auto-runs/day, contractions,
  auto-merge rate) → charts on the existing ops/metrics surface.
- **Alerts** — see §3.

### 3. Push-first awareness — even (especially) when autonomous

In autonomous mode the operator is out of the loop *by design*, so the channel inverts:
push becomes **"here's what I did,"** not "approve this." Every autonomy event can push;
the routing is a per-event `alerts.<event>` preference resolved system→project:
- **Default `push`:** `trust_contracted` (your project paused — you must know), `auto_merged`,
  `auto_ran` start, `proposal_surfaced` for high-value work.
- **Default `digest`/off:** `gate_held` (already an inbox `needs_review`), `gate_passed`,
  `trust_promoted` (good news, low urgency → digest).

**This is not a second inbox.** Alerts are fire-and-forget notifications + the queryable
log; the decisions inbox stays the single *attention sink* (things that want a verdict).
Reuses the existing push subsystem (`push/dispatcher.ts`, the `NotificationsSection`).

### 4. IA discipline — a dedicated Autonomy surface, preset-first

Do **not** scatter ~10 knobs × 2 scopes across the flat settings list and the project page.
- **One "Autonomy" panel** (system: its own settings route/section that opens a focused
  panel, not inline rows; project: an "Autonomy" tab/disclosure on the project page).
- **Preset-first, progressive disclosure.** Most operators pick a **preset** —
  `Conservative` (everything gated, alerts loud) / `Balanced` / `Hands-off` (Phase C on for
  contained work) — which sets the whole bundle; an "Advanced" expansion exposes individual
  knobs. The per-project panel is **inheritance-aware**: each knob shows *inherited (system)*
  vs *overridden*, with one click to override or revert-to-inherit.
- The project header keeps only the **state** at a glance (current level + trend chip from
  ADR-012); the *policy* lives behind the Autonomy panel.

## The remaining features, as consumers of the above

- **Slice 2 surfacing (smallest):** Trust moves already happen; emit an `autonomy_event` +
  route through §3 alerts; add the header level/trend chip. *Closes the ADR-012 follow-up.*
- **Slice 3 — L3 bounded auto-retry:** transient `blocked_run`/`merge_failure` auto-retry
  within `retry.transientBudget`, escalate to the inbox on exhaustion; each attempt is an
  `auto_retried` event. Never retries the structural human blocks (missing secret, hardware,
  verdict).
- **Phase C / L4 — auto-run (the endgame, most dangerous):** Watch-generated work whose class
  ∈ `autorun.classes` and blast-radius ≤ `autorun.maxBlastRadius` auto-submits a run **only
  when `autorun.enabled` (default OFF) and the project is at the top rung**; the run still
  flows through the verifier gate (auto-land vs held) and the Trust Ladder (a failure
  contracts). Surface-first: every auto-run pushes (§3) and logs; the operator can watch and
  intervene. This needs its **own ADR** (retry/loop bounds, class taxonomy, kill-switch).

## Contracts (don't break)

- **Operator is the only path to a repo write until a class is gate-proven** (VISION/ADR-004).
  `autorun.enabled` defaults OFF; auto-run is opt-in per project, top-rung only, smallest
  blast-radius class first.
- **The inbox stays the single attention sink.** Autonomy events are notifications + a log,
  never inbox cards (the one exception is `proposal_surfaced`, which is *already* an inbox
  insight by design).
- **Conservative defaults, earned escalation.** New projects inherit `Conservative`; nothing
  auto-runs without explicit opt-in.
- **One resolver, one event log.** No feature reads a raw knob or logs autonomy actions
  directly — both go through the seams here (the ADR-015 discipline, applied to autonomy).

## Build sequence

1. **Config core** — `AutonomyConfig` type + `resolveAutonomyConfig` + `projects.autonomyConfig`
   blob + system setting keys; migrate the scattered knobs (autonomyMode stays state). No
   behavior change (defaults reproduce today).
2. **Event log + alerts** — `autonomy_events` table + a `recordAutonomyEvent` seam wired into
   the existing Trust-Ladder / gate sites; push routing via §3; the Slice-2 surfacing rides this.
3. **Autonomy UI** — the system + per-project Autonomy panels (preset-first, inheritance-aware)
   + the history timeline + the metric additions.
4. **Slice 3 (auto-retry)** then **Phase C (auto-run)** — both behind the config + emitting events.
   Phase C gets its own ADR.

## Open questions (for the operator)

1. **Preset definitions.** What exactly do `Conservative / Balanced / Hands-off` set? (Draft
   above; needs your tuning.)
2. **Default alert routing.** Confirm which events push by default vs digest (§3 proposal).
3. **Digest channel.** Is there a "daily autonomy digest" (one push/notification summarizing
   the log) or only per-event pushes? (Lean: per-event for loud ones + an optional digest.)
4. **Auto-run gating.** Top-rung-only + `enabled` + per-class — is per-*task-class* level
   (ADR-012 open-q1) in scope here, or still per-project only to start?
5. **Where does the Autonomy history live** — a tab on the existing ops/metrics surface, or its
   own route? (Lean: a section on `/ops`, since it's awareness not analysis.)
