---
id: task-001
title: Add tRPC metrics router with daily-bucket cost aggregations
status: done
priority: med
estimate: medium
created: 2026-05-23T03:56:21.448Z
updated: 2026-05-24T16:21:00.000Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] New apps/daemon/src/routers/metrics.ts exposes queries returning daily totals for: USD cost, input tokens, output tokens, cache-read/write tokens (whichever fields are populated on runs), and run count
- [ ] Each query accepts a time range (start/end ISO), an optional projectId scope, and an optional groupBy ('project' | 'model' | none)
- [ ] Queries treat NULL cost fields as 0 and return a zero-filled bucket series so charts render contiguous timelines
- [ ] EXPLAIN QUERY PLAN on a 10k-run sample shows index use on runs(createdAt) and runs(projectId, createdAt); add an index migration if absent
- [ ] Router registered in the root router and typed end-to-end on the PWA tRPC client

## Notes

Emitted by feature plan j92lvw5y: ""

