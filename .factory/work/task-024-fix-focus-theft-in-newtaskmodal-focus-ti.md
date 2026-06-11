---
id: task-024
title: "Fix focus theft in NewTaskModal: focus title once on mount, not every render"
status: ready
priority: med
estimate: small
created: 2026-06-11T12:35:30.855Z
updated: 2026-06-11T12:35:30.855Z
labels:
  - feedback
---

## Source

Captured from feedback fp06wh48npb67vwq1uu6eoir (project-detail on /projects/kxsocpgivti6mjbvuqt5my6i).

## Operator's note

When adding a task within a project, touching any form input or typing into the description field jumps the cursor back to the title input. 

## Agent's draft

In `apps/pwa/src/components/new-task-modal.tsx` the title `<input>` uses an inline `ref={(el) => el?.focus()}` callback. The new function identity each render makes React re-run it on every re-render, so any state change (typing in body, toggling kind/priority chips) yanks focus back to the title.

Replace the per-render focus with a mount-only focus — native `autoFocus`, or a `useRef` + `useEffect(() => ref.current?.focus(), [])`. Verify on a 390px viewport that typing in the body and switching chips no longer moves the cursor.

## Acceptance

- [ ] (TBD)
