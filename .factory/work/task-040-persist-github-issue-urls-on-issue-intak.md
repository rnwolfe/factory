---
id: task-040
title: Persist GitHub issue URLs on issue intake decisions
status: ready
priority: med
estimate: small
created: 2026-06-14T11:16:07.255Z
updated: 2026-06-14T11:16:07.255Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] GitHub issue webhook intake captures issue.html_url when creating an issue_intake decision payload.
- [ ] Existing issue_intake payloads without a URL continue to parse and render without errors.
- [ ] Focused tests cover issue_intake payload creation with and without html_url.

## Notes

Emitted by feature plan hhw18821: "Surface source links wherever provenance exists (starting with issue_intake)"

