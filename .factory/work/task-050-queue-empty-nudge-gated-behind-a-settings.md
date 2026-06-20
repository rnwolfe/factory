---
id: task-050
title: Queue-empty nudge (settings-flag gated) when a project runs out of runway
status: done
priority: med
estimate: small
created: 2026-06-20T05:11:00.000Z
updated: 2026-06-20T05:11:00.000Z
labels:
  - audit
  - inbox
---

## Source

Prod-usage audit (14d ending 2026-06-20), feature proposal #3. See
`tasks/audit-prod-14d-2026-06-20.md`.

## Operator's note

A project whose task list goes all-`done` with auto-advance on just stalls
silently — nothing surfaces it. fathom sat dormant for ~5 weeks (last commit
2026-05-17, all 5 phase-tasks done) with no signal that it was out of runway.
Surface a nudge so the operator can re-fill or archive.

**Gate this behind a settings flag** — it must be opt-in/disable-able, not
always-on, so it doesn't add inbox noise for projects the operator is
deliberately parking.

## Agent's draft

- Add a setting (e.g. `notify-on-queue-empty`, default off) in the `settings`
  table / settings router. Consider a per-project override consistent with how
  `auto_advance` is modeled per project; at minimum a global flag.
- When auto-advance finishes a project's last ready task and finds no remaining
  `ready` tasks (the auto-advance "next ready task" scan in
  `apps/daemon/src/projects/tasks.ts` / the runner's advance path), and the flag
  is enabled, emit one inbox item: "project <slug> is out of runway — re-fill or
  archive?" Link to the project.
- De-dupe: only one open queue-empty nudge per project at a time; clear it when
  new ready tasks appear or the project is archived. Don't re-fire on every
  run completion.
- Respect projects with auto-advance off (no nudge — that's a deliberate manual
  cadence) unless the operator opts those in too.

## Acceptance

- With the flag OFF (default), behavior is unchanged — no queue-empty inbox items.
- With the flag ON, a project transitioning to zero `ready` tasks emits exactly
  one inbox nudge linking the project; it does not re-fire while still empty.
- The nudge clears when ready tasks reappear or the project is archived.
- A short test covers: flag-off no-op, flag-on single-fire, and de-dupe.
