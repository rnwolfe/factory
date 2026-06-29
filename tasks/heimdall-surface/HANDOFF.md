# Handoff: Heimdall / Factory — full surface visual direction

> Source: claude.ai/design project "Factory visual identity direction"
> (`design_handoff_heimdall_surface/README.md`). Saved here as the working spec.

## Overview
A cohesive visual-system pass across the Factory PWA (the operator app, "Heimdall"),
re-grounded on the autonomy features through **v0.39** (self-moving trust ladder,
verifier-coverage gate, cross-model validation, self-healing retry, The Watch as a work
generator, Phase-C auto-run + kill-switch, operator memory).

The thesis: now that the system acts on its own, the UI must make **three things felt at a
glance** —
1. **What needs you** — amber, strictly rationed.
2. **What the system is doing on its own** — a new calm teal.
3. **How far you've let it go** — the trust ladder, always visible.

This is a **refinement of the existing identity**, not a reskin. Warm-dark stays sacred,
Fraunces / Geist / Geist Mono stay, chips-not-pills + hairlines + graph-paper grain stay.

The HTML board (`Factory Heimdall Surface.dc.html`) is a design REFERENCE (12 phone screens
at 390px), not code to copy. Fold the decisions into `apps/pwa` reusing the token + utility
system. Most of the work is EDITING existing components.

## Design tokens

### Existing tokens — stylesheet is source of truth (values below from real app.css)
Keep these as-is; the README's claimed values had drift. Real values:
- `--color-bg` hsl(30 10% 5%) · `--color-bg-1` hsl(30 9% 8%) · `--color-bg-2` hsl(30 8% 11%) · `--color-bg-3` hsl(30 7% 15%)
- `--color-line` hsl(30 5% 22%) · `--color-line-bright` hsl(30 5% 32%)
- `--color-fg` hsl(40 14% 88%) · `--color-fg-1` hsl(40 12% 78%) · `--color-fg-2` hsl(35 10% 60%) · `--color-fg-3` hsl(30 8% 42%)
- `--color-accent` hsl(22 88% 60%) — AMBER, "needs you" only
- verdicts: greenlit hsl(140 42% 58%) · parked hsl(40 70% 60%) · decompose hsl(220 55% 70%) · trashed hsl(0 55% 58%)

### NEW tokens to add (the core of this pass)
- `--color-working`      hsl(190 38% 56%) — TEAL — working & autonomous: in-flight runs, auto actions, trust-ladder fill, ambient status, The Watch, Heimdall's voice
- `--color-working-dim`  hsl(190 28% 36%) — lower trust rung / past-progress fill
- `--color-working-deep` hsl(190 40% 45%) — teal borders/glows at low alpha (/.14–/.5)
Tinted teal surfaces (auto rows, autonomy policy card): bg hsl(190 25% 8% / .5), border hsl(190 30% 30% / .3).
Also add soft/line variants to mirror accent: `--color-working-soft` hsl(190 30% 20% / .18), `--color-working-line` hsl(190 40% 45% / .40).

### The single most important rule
**Amber is a budget: at most one amber element per screen, always meaning "a decision/action is yours."**
Demote everything else currently amber:
- active nav tab → NOT amber. fg-1 icon + 2px top tick.
- in-progress / running → TEAL, never amber.
- primary buttons that aren't "the decision" (e.g. Capture submit) → neutral bright (fg-1 fill, dark text).
- amber stays on: inbox needs-you badge, needs-you decision rows + their primary verdict button,
  held-for-review approve, emergency-stop affordance accent.

### Typography (unchanged)
- Fraunces (.display) — headlines, decision titles, the one number that matters, verdicts.
- Geist — body, labels, controls.
- Geist Mono (.mono) — ids, metrics, timestamps, state labels, section eyebrows (uppercase, letter-spacing .14–.18em).

### Spacing / radius / motion
- Card radius 9–12px; chips 2px (stay sharp); phone-level cards 10–11px. (NB: existing .surface is 4px — board uses softer phone cards.)
- Hairlines 1px solid --color-line.
- Motion calm: pulse 1.7s (live dots), breathe 3.6s box-shadow (active run cards).
  Teal glows: box-shadow 0 0 8–16px hsl(190 45% 50% / .25–.7). Nothing fast/bouncy. Respect prefers-reduced-motion.

## Reusable patterns (build as shared components FIRST)
1. **Trust-ladder indicator** — 3 segments (supervised → collaborative → autonomous). Past+current
   filled teal (working-dim then working), future hsl(30 6% 24%). Two sizes: inline (3× 13×4px bars +
   mono label) for rows; block (3 columns, active bar taller w/ glow + labels) for autonomy tab.
2. **"auto" chip** — unattended marker. Mono 9px uppercase, teal text, teal border /.5, teal fill /.14,
   radius 2px. e.g. `auto · merged`, `auto · ran`. Distinct from amber "needs you".
3. **Verifier-coverage pips** — three signals (acceptance / quality / cross-model), each 9px dot:
   pass = filled greenlit, fail = filled trashed, absent = HOLLOW RING parked-colour (border 1.5px, no
   fill). Plus level chip (none/low/medium/high). On run detail + compact 3-pip cluster wherever a run
   is referenced.
4. **Attention group header** — mono eyebrow + count + flex-1 hairline. Colour by group: needs-you amber,
   in-flight teal, done-while-away dim teal, settling fg-3.
5. **Bottom nav (Shell)** — 5 tabs, active = fg-1 icon + 26×2px top tick (radius 0 0 2 2), inactive fg-3.
   Inbox tab carries amber count badge. (Currently active tab is amber — change it.)

## Screens (phone, 390px, dark) — each names the route/component to edit
1. **Inbox** — routes/inbox.tsx + decision-card.tsx. Header → watch/ticker strip → scrolling GROUPS
   (group header + rich rows) → bottom nav (inbox active) → fade mask above nav. Rows are DESTINATIONS
   (one tap opens decision detail, no expand). Row: 3px left edge (amber if needs-you), Fraunces title,
   one context line, mono meta (verdict ▸ · project · score). Groups in order: needs you (amber) /
   in flight (teal, breathe, 3px progress bar, pulsing teal dot, ETA) / done while you were away
   (dim-teal, faint teal-tinted bg, auto chips, no action) / settling (collapsed count). Watch strip:
   Heimdall eye glyph + pulsing teal dot + `3 running · 7q · $4.20 today` + amber `2 need you` chip.
2. **Decision detail** — routes/decision-detail.tsx / inbox-detail-pane.tsx. Back header (‹ · "decision"
   · project chip) → kind chips + time → Fraunces headline → provenance line (source-link icon ·
   "captured from phone · routed by Heimdall") → Heimdall's read card (eye eyebrow, reasoning, 3 Fraunces
   stats: fit score / uncertainty / tasks) → effect note → verdict actions pinned bottom: full-width amber
   Approve + 3-up row (park / decompose / trash). Amber budget = Approve only.
3. **Capture** — capture route (new-idea.tsx / inbox/new). Header → Fraunces prompt "What should we
   build?" → one-line sub → large soft input (min-h 148px, radius 12, teal caret) → routing chips
   (project · courier + dashed "or let Heimdall route") → NEUTRAL-BRIGHT Capture button (NOT amber) →
   reassurance line w/ eye glyph ("triaged the moment it lands · verdict in your inbox"). Nav: capture active.
4. **Projects portfolio** — routes/projects.tsx. Header (+count) → summary strip
   (`3 working · 5 idle · 1 needs you`) → project rows. Row: Fraunces name; right = live state (teal dot +
   "N running" / `auto · N merged today` / amber "needs you" / "idle"); second line = inline trust-ladder +
   mono label + right-aligned `Nq · NN% merged`. Needs-you row gets amber left edge.
5. **Project dashboard** — routes/project.tsx / project-detail.tsx (overview tab). Back + Fraunces title +
   gear → project tab bar (overview · autonomy · runs · settings; active = fg-1 + 2px underline) → posture
   card (teal pulse dot, "Healthy · running itself", inline trust ladder, "tune ›") → 3-up vitals (queued /
   runs today / merged%) → in flight (teal, progress) → next up (numbered queue) → recently merged
   (✓ + auto chip on unattended).
6. **Project autonomy tab** — autonomy-panel.tsx (project scope). Maps 1:1 to existing AutonomyPanel.
   tab bar (autonomy active, teal underline) → preset row (Conservative / Balanced / Hands-off; active =
   teal fill+border) + blurb → trust-ladder block (3-col, active glows, "3 of 5 clean runs toward
   autonomous · contracts on any failure") → effective policy card (mono rows: gate / watch / autorun
   [shows "off · ships dark"] / retry; "inherited from system" chip + "advanced · every knob ›") →
   emergency stop pinned near bottom: red-tinted card, power glyph, "halt all unattended action, now",
   toggle. "ships dark" must read honestly where auto-run is off-by-default.
7. **Project settings** — routes/project.tsx (settings tab). tab bar (settings active) → grouped list:
   agent · model (default agent chip), task backend (GitHub Issues toggle, "the issue is the task"),
   notify-on-empty-queue toggle, conventions · skills (AGENTS.md · the doctrine [14], Skills [3 loaded]),
   danger (Delete project, trashed colour). Toggles = teal when on.
8. **Run / execution detail** — routes/live-pane.tsx (run) + run-event-stream.tsx + verifier-report.tsx.
   Back header (run id + state chip; here "held for review" parked colour) → context chips (project · task ·
   agent·model) → verifier-coverage report (parked-tinted border; level chip; 3 pip rows: acceptance pass
   4/4, quality pass, cross-model fail · codex; explanation "below high + contained — auto-merge withheld")
   → self-healing card (teal, breathe, "retry 1 of 2 · findings fed back") → event stream (mono rows;
   commit row highlighted amber; token/cost/time footer) → actions: amber Approve retry + outline Intervene.
   Happy path (autonomous + high coverage): state chip = `auto · merged` (teal), no actions.
9. **Ops / autonomy log** — routes/ops.tsx + AutonomyHistory. Read-only, never an action queue. Back
   header ("Ops") → snapshot strip (running / queued / $ today / tokens; running teal) → autonomy ·
   unattended timeline (activity-glyph eyebrow). Row = fixed-width event chip (auto merged / auto ran =
   teal·greenlit, promoted = greenlit, gate held = parked, contracted = trashed) + message + project·run
   mono + relative time. Calmer/denser than inbox.
10. **Metrics** — routes/metrics.tsx + autonomy-metrics.tsx + watch-panel. Read-only. Header (+range) →
    north-star card: "decisions per run" eyebrow, huge Fraunces `0.38`, "↓ 22% · less you" (down good →
    greenlit), teal sparkline, one-line gloss → 2×2 metric tiles (auto-ratify rate / throughput /
    self-heal resolved ratio / agent work) → The Watch card (eye eyebrow, cadence, funnel: surfaced /
    adopted / note-only).
11. **Operator memory** — routes/memory.tsx + memory-view. Back header ("Operator memory" + count) →
    one-line explainer → category sections (workflow / style …) → fact cards: the convention (mono inline
    for code like `bun test`) + mono provenance line in TEAL ("from the watch · adopted 3d ago", "from
    claude code · synthesized", "ratified decision · 1w ago").
12. **Global settings** — routes/settings.tsx + autonomy-panel.tsx (system scope). Header → autonomy
    policy card PINNED AT TOP (teal-tinted, eye eyebrow "autonomy policy · system", Fraunces "Balanced",
    "applies to all projects" chip, blurb, "open full policy ›") → groups: operator (operator memory,
    notifications & alerts, default agent·model), library (task templates, experimental · fable 5 toggle,
    about · release notes + version).

## Interactions & behaviour
- Row → detail: every inbox/portfolio/queue row is single-tap link to detail route. No intermediate expand.
- Swipe (inbox rows): leave room for swipe-to-act (approve/park) fast path; tap still opens detail. (Exists.)
- Live updates: in-flight cards subscribe to run events (existing WS) — progress bar, pulse dot, ETA live.
  Watch/ticker strip refetches ops snapshot (existing 30s fallback).
- Trust-ladder moves are system-driven; surface a push + transient header chip on promote/contract.
- Emergency stop: guarded toggle; flipping halts unattended action immediately, visibly changes autonomy
  chrome (auto chips → paused) across surfaces. Reads/writes `autorun.emergencyStop` (existing knob).
- Motion: pulse (live), breathe (active run). Respect prefers-reduced-motion → static opacity/shadow.

## State management
No new global state. Derived bits:
- inbox grouping key per item: needs_you | in_flight | unattended | settling (from decision kind + run
  state + autonomy event).
- per-project trustLevel (autonomy config: supervised|collaborative|autonomous) + promote-streak progress.
- verifier report shape already exists (verifier-report.tsx): per-signal pass/fail/absent + level.
- emergency-stop reads/writes autorun.emergencyStop.

## Assets / icons
- lucide (already a dep): inbox, pen-line, layers, line-chart, settings/cog, power, activity, link.
  stroke ~1.6 (2.0 when active).
- Heimdall mark: simple watcher "eye" glyph (vesica + filled pupil) used in watch strip, capture
  reassurance, The Watch, system autonomy card. Lift inline SVG into a small `HeimdallMark` component.
  (A real favicon/Heimdall mark already ships per v0.20.0 — reuse if it reads at small size.)
- No raster assets. No new fonts.

## Suggested implementation order
1. Tokens first: add --color-working*; audit & demote amber per the budget rule.
2. Shared patterns: trust-ladder, auto chip, verifier pips, attention-group header, Shell nav tick.
3. Inbox grouping + rich rows → decision detail one-tap.
4. Project tabs (overview/autonomy/settings) + autonomy panel polish + kill-switch placement.
5. Run detail verifier report + self-healing; ops log; metrics north-star; memory; global settings.
