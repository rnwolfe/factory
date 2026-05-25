---
id: task-005
title: "Regression: run pane empty on revisit — re-pin event seed + diff load"
status: done
priority: med
estimate: small
created: 2026-05-23T04:04:06.570Z
updated: 2026-05-25T00:21:42.757Z
labels:
  - feedback
---

## Source

Captured from feedback uo4gxkvkyw24fdia0hf5nvb5 (run-pane on /projects/kxsocpgivti6mjbvuqt5my6i/runs/qjc6bs923k6cc4795j2kil09).

## Operator's note

When I open a previous run, I don't see the events/changes - everything is empty. If I open an ongoing run, it is all empty until a new event occurs and then it continues to build out. Runs should be captured in totality, and not "viewed from this point forward."

## Agent's draft

Reproduce on run `qjc6bs923k6cc4795j2kil09`: open DevTools, confirm whether `runs.events` and `runs.diff` are firing on mount and what they return. Check `events` table for that runId. Compare against the seed path in `run-event-stream.tsx:99-107` (data → `setEvents` → `setSeeded`) and the diff query in `live-pane.tsx:55-64`. Likely culprits: a query-key invalidation that drops the seed before render, the `enabled: !seeded` flag latching the wrong way after a remount, or `runs.diff` returning empty for runs whose branch is already merged. Add a regression test that mounts `RunEventStream` against a fixture with persisted rows and asserts they render before any live event arrives — the prior fixes (`2e0b2a6`, `fa08463`) didn't lock this behavior down with a test, which is why it can regress silently.

## Acceptance

- [ ] (TBD)


