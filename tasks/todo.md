# task-064 — Inbox / board reflects resurfaced work as still-open

## Acceptance
- [ ] A resurfaced (overridden) decision is no longer shown as resolved-and-done; the follow-up reads as open work needing implementation.
- [ ] Auto-advance / queue picks the resurfaced item up the same way it would any other ready task (or the operator is given a one-tap path to start it).

## Findings
- Tasks 061/062/063 already wire the daemon side: an override marks the decision `actioned`, emits a resurfacing signal, and re-queues a concrete `ready` task (file backend) / follow-up issue (github backend) carrying `sourceDecisionId`.
- Criterion 2 holds at the data layer: the re-queued task is `status: "ready"`, `pickNextReadyTask` (post-merge auto-advance) treats it like any other; the override also navigates straight into the task, which has a one-tap "run task" button.
- Criterion 1 is the gap: the overridden decision reads as closed in **history** and **decision-detail** ("this decision is actioned"), with no durable link to the follow-up task — the `resurfacedTaskId` is only returned ephemerally from the mutation, never persisted.

## Plan
- [ ] Backend: persist `resurfacedTaskId` on the decision payload in `overrideAgentDecision` (durable link for every surface).
- [ ] Backend: surface `sourceDecisionId` as a board provenance link (`taskSourceLinks` → `/decisions/<id>`).
- [ ] PWA `source-link.tsx`: add `decision` provenance kind.
- [ ] PWA `decision-detail.tsx`: reframe an overridden decision as "resurfaced → open work" with a one-tap link to the task; fix stale "refinement plan" copy.
- [ ] PWA `history.tsx`: render overridden agent_decisions as resurfaced/open, not a closed verdict; deep-link to the task.
- [ ] Tests: queue-eligibility + `resurfacedTaskId` persistence.
- [ ] typecheck + biome + targeted tests.

## Review
Tasks 061–063 already re-queue overridden work as a `ready` task/issue; task-064 closes
the loop so the *surfaces* stop reading it as done.

Changes:
- **daemon `routers/decisions.ts`** — `overrideAgentDecision` now persists `resurfacedTaskId`
  on the decision payload (single write, after the best-effort re-queue). This is the durable
  link every decision surface needs; previously it was only returned ephemerally.
- **daemon `routers/projects.ts`** — `taskSourceLinks` emits a `decision` provenance link
  (`from override` → `/decisions/<id>`) so the board shows where resurfaced work came from.
- **pwa `source-link.tsx`** — `decision` provenance kind.
- **pwa `decision-detail.tsx`** — an overridden decision renders a "resurfaced as open work"
  section with a one-tap link to the follow-up task; the terminal footer no longer reads as a
  dead "actioned"; the override-form helper copy now describes re-queueing (not the old
  refinement-plan behavior).
- **pwa `history.tsx`** + `decision-card.tsx` payload type — overridden agent_decisions show a
  `resurfaced → open` chip and lead with the decision summary, not the `decided: …` verdict.

Criterion 2 was already met by the data model (the re-queued task is `ready`); added a test
asserting `pickNextReadyTask` (the function auto-advance uses) selects it like any other ready
task, plus a test that `resurfacedTaskId` lands on the payload.

Verification: `bun run typecheck` clean · `bun run check` clean (2 pre-existing warnings) ·
`bun test` decisions-router (7), resurface-github (1), inbox-resurface (1), github-task-store
(20), pwa source-link (9) all pass.
</content>
</invoke>
