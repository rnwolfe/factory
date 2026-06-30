---
id: task-066
title: Raise ship-feature goal limit from 280 to 2000 chars
status: ready
priority: med
estimate: small
created: 2026-06-30T02:31:20.732Z
updated: 2026-06-30T02:31:20.732Z
labels:
  - feedback
---

## Source

Captured from feedback fw4b4wlofp9l7vy6r40n2uge (inbox on /).

## Operator's note

The ship feature input has a 280 character limit for some reason? Seems really unnecessary?

## Agent's draft

Bump the `goal` validator in `startFeaturePlan` (`apps/daemon/src/routers/plans.ts:202`) from `z.string().min(1).max(280)` to `.max(2000)`, matching the sibling refinement-goal input at line 301. No client-side maxLength exists, so this is the only enforced cap. One-line change, no migration.

## Triage context

### Agent - 2026-06-30T02:24:30.064Z

The grep output is RTK-mangled ("ship"→"ln"), but it pointed me to the right file: `feature-plan-launch.tsx` is the "ship feature" component. Let me read it.No client-side limit here. The 280 cap must be in the server-side tRPC validation for `startFeaturePlan`. Let me check.Confirmed. The 280-char cap is server-side: `apps/daemon/src/routers/plans.ts:202` validates the ship-feature goal with `z.string().min(1).max(280)`. The textarea itself has no limit, so anything over 280 chars just gets bounced by the server with a validation error.

You're right that it's arbitrary — 280 is a Twitter-tweet number, not a meaningful constraint on a feature brief. The sibling input two procedures down (the refinement goal at line 301) already allows `max(2000)`, so the ship-feature field is the odd one out. Someone naming a feature with a sentence of context easily blows past 280.

The fix is a one-line bump — raise the `.max()` to match the 2000 used elsewhere (or drop it to something generous). Low risk, no schema/migration involved; it just widens an input validator.

```json
{
  "kind": "task",
  "title": "Raise ship-feature goal limit from 280 to 2000 chars",
  "summary": "Bump the `goal` validator in `startFeaturePlan` (`apps/daemon/src/routers/plans.ts:202`) from `z.string().min(1).max(280)` to `.max(2000)`, matching the sibling refinement-goal input at line 301. No client-side maxLength exists, so this is the only enforced cap. One-line change, no migration."
}
```

The `reasoning` field: a single, well-scoped one-line validator change with a known file and exact diff — not enough surface area to decompose into a plan, and clearly actionable so not a dismiss.

```json
{
  "kind": "task",
  "title": "Raise ship-feature goal limit from 280 to 2000 chars",
  "summary": "Bump the `goal` validator in `startFeaturePlan` (`apps/daemon/src/routers/plans.ts:202`) from `z.string().min(1).max(280)` to `.max(2000)`, matching the sibling refinement-goal input at line 301. No client-side maxLength exists, so the server validator is the only enforced cap. One-line change, no migration.",
  "reasoning": "The feedback points at one arbitrary `.max(280)` with a confirmed exact location and a sibling input already at 2000 — a single discrete edit, not multi-step work, and concrete enough not to dismiss."
}
```Confirmed. The 280-char cap is server-side: `apps/daemon/src/routers/plans.ts:202` validates the ship-feature goal with `z.string().min(1).max(280)`. The textarea itself has no limit, so anything over 280 chars just gets bounced by the server with a validation error.

You're right that it's arbitrary — 280 is a Twitter-tweet number, not a meaningful constraint on a feature brief. The sibling input two procedures down (the refinement goal at line 301) already allows `max(2000)`, so the ship-feature field is the odd one out. Someone naming a feature with a sentence of context easily blows past 280.

The fix is a one-line bump — raise the `.max()` to match the 2000 used elsewhere (or drop it to something generous). Low risk, no schema/migration involved; it just widens an input validator.

```json
{
  "kind": "task",
  "title": "Raise ship-feature goal limit from 280 to 2000 chars",
  "summary": "Bump the `goal` validator in `startFeaturePlan` (`apps/daemon/src/routers/plans.ts:202`) from `z.string().min(1).max(280)` to `.max(2000)`, matching the sibling refinement-goal input at line 301. No client-side maxLength exists, so this is the only enforced cap. One-line change, no migration."
}
```

The `reasoning` field: a single, well-scoped one-line validator change with a known file and exact diff — not enough surface area to decompose into a plan, and clearly actionable so not a dismiss.

```json
{
  "kind": "task",
  "title": "Raise ship-feature goal limit from 280 to 2000 chars",
  "summary": "Bump the `goal` validator in `startFeaturePlan` (`apps/daemon/src/routers/plans.ts:202`) from `z.string().min(1).max(280)` to `.max(2000)`, matching the sibling refinement-goal input at line 301. No client-side maxLength exists, so the server validator is the only enforced cap. One-line change, no migration.",
  "reasoning": "The feedback points at one arbitrary `.max(280)` with a confirmed exact location and a sibling input already at 2000 — a single discrete edit, not multi-step work, and concrete enough not to dismiss."
}
```

## Acceptance

- [ ] (TBD)
