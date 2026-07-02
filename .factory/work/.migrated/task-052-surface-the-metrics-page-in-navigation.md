---
id: task-052
title: Surface the /metrics page in navigation
status: done
priority: med
estimate: small
created: 2026-06-21T03:18:29.142Z
updated: 2026-06-21T03:28:00.626Z
labels:
  - feedback
---

## Source

Captured from feedback vurxhv9xlqa3grs7la9ogg49 (metrics on /metrics?projectId=l0bbq6nns5rv8o5v2mrfqofq).

## Operator's note

The detailed metrics page is not viewable via any menu. It is buried behind a collapsed by default project level metrics on the project page. 

## Agent's draft

Add a persistent nav entry to the detailed metrics page (`/metrics`) on both desktop chrome (sidebar/top-bar) and mobile nav, so it's reachable without the command palette. Add a 'View full metrics →' link from the project-detail metrics section into the project-scoped view (`/metrics?projectId=…`), and consider defaulting that collapsed section to expanded.

## Triage context

### Agent - 2026-06-21T03:15:06.991Z

You're right — `/metrics` is a real route (registered in `app.tsx`, and it's even in the command palette), but it has no menu entry anywhere. The only path to it for someone not using ⌘K is the collapsed project-level metrics block on the project page, which defaults closed. So a whole page exists that's effectively undiscoverable through normal navigation.

This is a discrete fix rather than a design project: the page already exists and renders fine — what's missing is a durable entry point. Most direct option is a nav link (sidebar/top-bar on desktop, and wherever the mobile nav lives) pointing at `/metrics`, plus optionally defaulting the project-detail metrics section to expanded or giving it a "View full metrics →" link. I'd keep the scope to "make it reachable from a menu" and leave the collapse-default as a smaller judgment call inside that.

One thing worth your call: the global `/metrics` page vs. the per-project metrics view you captured this from (`?projectId=…`) — I'd surface both, a top-level nav entry for the global page and a clear link from the project header into the project-scoped view.

```json
{
  "kind": "task",
  "title": "Surface the /metrics page in navigation",
  "summary": "Add a persistent nav entry to the detailed metrics page (`/metrics`) on both desktop chrome (sidebar/top-bar) and mobile nav, so it's reachable without the command palette. Add a 'View full metrics →' link from the project-detail metrics section into the project-scoped view (`/metrics?projectId=…`), and consider defaulting that collapsed section to expanded.",
  "reasoning": "The route, page, and even a command-palette entry already exist — the only gap named in the feedback is a discoverable menu entry, which is a single self-contained UI change, not work needing decomposition."
}
```You're right — `/metrics` is a real route (registered in `app.tsx`, and it's even in the command palette), but it has no menu entry anywhere. The only path to it for someone not using ⌘K is the collapsed project-level metrics block on the project page, which defaults closed. So a whole page exists that's effectively undiscoverable through normal navigation.

This is a discrete fix rather than a design project: the page already exists and renders fine — what's missing is a durable entry point. Most direct option is a nav link (sidebar/top-bar on desktop, and wherever the mobile nav lives) pointing at `/metrics`, plus optionally defaulting the project-detail metrics section to expanded or giving it a "View full metrics →" link. I'd keep the scope to "make it reachable from a menu" and leave the collapse-default as a smaller judgment call inside that.

One thing worth your call: the global `/metrics` page vs. the per-project metrics view you captured this from (`?projectId=…`) — I'd surface both, a top-level nav entry for the global page and a clear link from the project header into the project-scoped view.

```json
{
  "kind": "task",
  "title": "Surface the /metrics page in navigation",
  "summary": "Add a persistent nav entry to the detailed metrics page (`/metrics`) on both desktop chrome (sidebar/top-bar) and mobile nav, so it's reachable without the command palette. Add a 'View full metrics →' link from the project-detail metrics section into the project-scoped view (`/metrics?projectId=…`), and consider defaulting that collapsed section to expanded.",
  "reasoning": "The route, page, and even a command-palette entry already exist — the only gap named in the feedback is a discoverable menu entry, which is a single self-contained UI change, not work needing decomposition."
}
```

## Acceptance

- [ ] (TBD)

