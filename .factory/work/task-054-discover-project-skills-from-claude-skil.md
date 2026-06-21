---
id: task-054
title: Discover project skills from `.claude/skills/` (loader + index)
status: done
priority: med
estimate: medium
created: 2026-06-21T12:15:59.179Z
updated: 2026-06-21T12:21:15.426Z
labels:
  - feature-plan-task
sourcePlanId: am7ozbki925cvw61ne66zqq9
---

## Acceptance

- [ ] A single-point-of-truth loader module (mirroring `projects/audit-skills.ts`) scans `<project>/.claude/skills/*/SKILL.md` and parses each skill's name + description from its frontmatter
- [ ] Projects with no `.claude/skills/` directory (or no SKILL.md files) return an empty list without throwing
- [ ] Discovery follows the repo-canonical convention: skills live in the project repo; Factory only indexes them at query time

## Notes

Emitted by feature plan am7ozbki: "Surface project skills on the project page with harness-agnostic execution"


