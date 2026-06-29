# Heimdall surface pass — review

Branch `feat/heimdall-surface` · 5 commits · 30 files · +1838/−326.
Full gate green: typecheck (all packages), `bun run check` (only 2 pre-existing
`require` warnings), `bun --filter @factory/pwa build`, `bun run test`
(daemon 497 / pwa 51 / cli 40 / runtime 48, 0 fail).

## What shipped (vs HANDOFF.md)

**Language (Phase 0–1).** Teal token family (`--color-working*`) + tinted-surface +
rung-empty; `.chip-working` / `.chip-auto` / verifier `.vpip` pips / trust-ladder
`.rung` / `.btn-bright` / `.btn-working`; `breathe` + `pulse-dot` + `indeterminate`
keyframes with `prefers-reduced-motion` fallbacks. New atoms: HeimdallMark (eye),
AutoChip, TrustLadder (inline+block, derived 3-rung), AttentionHeader. verifier-report
refactored from ✓/✗/— glyphs to the 3-pip system. Shell nav: amber active tab →
fg-1 + 2px tick; amber inbox needs-you badge.

**Data (Phase 2).** `projects/trust-stats.ts` (deriveTrustRung, projectTrustState,
projectMergeStats) reusing `cleanStreak`. `projects.list`/`get` attach `{trust, stats}`;
`autonomy.config` includes project trust state; `decisions.ambient` (in-flight runs +
unattended events) and `decisions.needsYouCount`. Unit tests for the derivations.

**Screens (Phase 3–5).** All 12: inbox attention groups + watch strip; decision detail
one-amber-Approve + teal auto markers; capture neutral-bright; portfolio rich rows +
trust ladder; project dashboard overview/settings tabs + **mobile tab bar** + posture;
autonomy panel preset-teal + block ladder + **emergency-stop kill-switch card**; run
detail teal/parked states + self-healing card; ops/metrics/memory/settings recolors +
pinned system-autonomy card.

The thesis is legible everywhere: **amber = needs you** (≤1 per screen), **teal = the
system working/auto**, **trust ladder = how far you've let it go**.

## Deliberate scope calls (no invented data)
- `auto · merged` happy-path chip on run detail: **skipped** — no per-run auto-merge flag.
- Self-heal-resolved-ratio metric tile: **skipped** — `auto_retried`/`auto_retry_exhausted`
  aren't in the metrics catalog.
- Portfolio "needs you" summary segment: **omitted** — no per-project needs-you signal.
- Project-detail full 4-tab rename → delivered as overview+settings added alongside the
  existing tabs (preserves tasks/audits/workdir features); controls relocated, none removed.

## Possible follow-ups
- Surface per-run auto-merge + retry-attempt counters from the daemon to light up the
  run-detail `auto · merged` chip and a precise "retry N of M".
- Add a self-heal-resolved metric series for the metrics north-star grid.
- model-picker selected chip is still amber (shared component, out of scope here).
