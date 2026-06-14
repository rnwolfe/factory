---
id: task-035
title: "Task page: use fused AgentModelPicker so codex models appear"
status: done
priority: med
estimate: small
created: 2026-06-14T10:58:56.265Z
updated: 2026-06-14T11:04:33.202Z
labels:
  - feedback
---

## Source

Captured from feedback srdfypl0t8kukt4zujano46q (task-detail on /projects/nhhr6ehysl0mi2rq0mnmo8db/tasks/task-034).

## Operator's note

Model list on task page only include Claude and not codex models. 

## Agent's draft

Replace the legacy `ModelPicker` in `apps/pwa/src/routes/task-detail.tsx` with `AgentModelPicker`, persisting both `fm.agent` and `fm.model` via task-frontmatter mutations (mirror `project-detail.tsx`). The model chip row then switches per selected agent, so codex projects can pin codex + its models instead of being stuck on the claude-only lineup.

## Acceptance

- [ ] (TBD)

