---
id: task-011
title: "Schema: add retry linkage column on runs table"
status: done
priority: med
estimate: small
created: 2026-05-24T01:46:25.591Z
updated: 2026-05-25T00:24:28.094Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] runs table gains a nullable retry_of_run_id column
- [ ] drizzle-kit migration is generated and checked in
- [ ] existing rows do not require backfill

## Notes

Emitted by feature plan mpdvz63d: "feedback: Sometimes plans fail after exiting for an unknown reason and"


