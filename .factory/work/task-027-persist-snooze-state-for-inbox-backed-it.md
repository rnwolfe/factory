---
id: task-027
title: Persist snooze state for inbox-backed items
status: done
priority: med
estimate: medium
created: 2026-06-13T14:39:41.248Z
updated: 2026-06-14T10:51:21.985Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] Inbox items that can appear in the decisions inbox have a persisted nullable `snoozedUntil` timestamp or equivalent per-type storage.
- [ ] A checked-in migration adds the snooze storage without hand-editing generated migration output.
- [ ] Existing unsnoozed items continue to appear normally after migration.

## Notes

Emitted by feature plan aqtei72j: "Snooze inbox items with timed resurfacing"


