---
id: task-051
title: Fix invasive floating position of plan-detail freeze button
status: ready
priority: med
estimate: small
created: 2026-06-21T03:12:06.537Z
updated: 2026-06-21T03:12:06.537Z
labels:
  - feedback
---

## Source

Captured from feedback fs9s472oajtrt1he55676xg3 (plan-detail on /plans/nl6qog71xlu0kol1g0skc8qe).

## Operator's note

The freeze button is always floating in an invasive place on the screen. Look everywhere the button is and review its positioning. 

## Agent's draft

The freeze control in `plan-detail.tsx` is wrapped in `sticky bottom-[calc(72px+env(safe-area-inset-bottom))]`, leaving a full-width primary button floating above the bottom nav and overlapping draft content on a 390px viewport. Rework its anchoring — preferably drop the sticky and let it sit in the action column like the adjacent abandon/archive confirm blocks, or make stickiness content-aware so it stops obscuring the plan. Verify on mobile + desktop across drafting/frozen/superseded states.

## Triage context

### Agent - 2026-06-21T03:06:35.046Z

I'll look at where the freeze button lives in the PWA to ground my recommendation.Let me see how the freeze button is positioned — is it floating/fixed?I found it. There's really one freeze button — in `plan-detail.tsx:471-480`. It renders inside a sticky wrapper:

```jsx
<div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))]">
  <button className="btn btn-primary w-full">
    <Snowflake size={14} /> freeze
  </button>
</div>
```

That `sticky bottom-[72px+…]` is the invasive bit: it pins the full-width primary button just above the bottom nav and keeps it floating over the plan content as you scroll the draft — on a 390px viewport it overlaps the very content you're reading to decide whether to freeze. The other "freeze" hits in the codebase (`plan-card.tsx`, `plan-draft-viewer.tsx`, `feature-plan-launch.tsx`) are just hint copy or the feature-plan launch modal's own button, not this floating control.

The fix is bounded and single-surface: rework how/where this control anchors. Options worth weighing — let it sit at the natural end of the action column (non-sticky) like the abandon/archive confirms right next to it already do; or keep it docked but as a slimmer bar that doesn't obscure content; or only make it sticky once the draft scrolls past a threshold. I'd lean toward matching the sibling confirm blocks (non-floating, in flow) since they're the established pattern in this exact component. This is one discrete change, so I'm routing it as a task rather than a plan.

```json
{
  "kind": "task",
  "title": "Fix invasive floating position of plan-detail freeze button",
  "summary": "The freeze control in `plan-detail.tsx` is wrapped in `sticky bottom-[calc(72px+env(safe-area-inset-bottom))]`, leaving a full-width primary button floating above the bottom nav and overlapping draft content on a 390px viewport. Rework its anchoring — preferably drop the sticky and let it sit in the action column like the adjacent abandon/archive confirm blocks, or make stickiness content-aware so it stops obscuring the plan. Verify on mobile + desktop across drafting/frozen/superseded states."
,
  "reasoning": "The complaint targets a single concrete control with one offending CSS positioning rule on one surface — a bounded fix, not multi-part work needing decomposition, so task over plan; and it names a real, reproducible UX defect, so not dismiss."
}
```I found it. There's really one freeze button — in `plan-detail.tsx:471-480`. It renders inside a sticky wrapper:

```jsx
<div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))]">
  <button className="btn btn-primary w-full">
    <Snowflake size={14} /> freeze
  </button>
</div>
```

That `sticky bottom-[72px+…]` is the invasive bit: it pins the full-width primary button just above the bottom nav and keeps it floating over the plan content as you scroll the draft — on a 390px viewport it overlaps the very content you're reading to decide whether to freeze. The other "freeze" hits in the codebase (`plan-card.tsx`, `plan-draft-viewer.tsx`, `feature-plan-launch.tsx`) are just hint copy or the feature-plan launch modal's own button, not this floating control.

The fix is bounded and single-surface: rework how/where this control anchors. Options worth weighing — let it sit at the natural end of the action column (non-sticky) like the abandon/archive confirms right next to it already do; or keep it docked but as a slimmer bar that doesn't obscure content; or only make it sticky once the draft scrolls past a threshold. I'd lean toward matching the sibling confirm blocks (non-floating, in flow) since they're the established pattern in this exact component. This is one discrete change, so I'm routing it as a task rather than a plan.

```json
{
  "kind": "task",
  "title": "Fix invasive floating position of plan-detail freeze button",
  "summary": "The freeze control in `plan-detail.tsx` is wrapped in `sticky bottom-[calc(72px+env(safe-area-inset-bottom))]`, leaving a full-width primary button floating above the bottom nav and overlapping draft content on a 390px viewport. Rework its anchoring — preferably drop the sticky and let it sit in the action column like the adjacent abandon/archive confirm blocks, or make stickiness content-aware so it stops obscuring the plan. Verify on mobile + desktop across drafting/frozen/superseded states."
,
  "reasoning": "The complaint targets a single concrete control with one offending CSS positioning rule on one surface — a bounded fix, not multi-part work needing decomposition, so task over plan; and it names a real, reproducible UX defect, so not dismiss."
}
```

## Acceptance

- [ ] (TBD)
