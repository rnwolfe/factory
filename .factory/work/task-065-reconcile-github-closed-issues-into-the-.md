---
id: task-065
title: Reconcile GitHub-closed issues into the Factory task list via webhook
status: done
priority: med
estimate: small
created: 2026-06-21T14:24:05.545Z
updated: 2026-06-21T22:02:45.826Z
labels:
  - feedback
---

## Source

Captured from feedback b54jdevj1arz2s6t8vvvdgmd (task-detail on /projects/l0bbq6nns5rv8o5v2mrfqofq/tasks/24).

## Operator's note

When a task is closed on GitHub, it doesn’t get removed from the in-factory project task list. 

## Agent's draft

Extend the GitHub webhook handler (`apps/daemon/src/github/webhook.ts`) to handle `issues.closed` and `issues.reopened`, currently unhandled — it only acts on `issues.opened` and `issue_comment.created`.

On close, look up the task by issue number in `github-task-store.ts` and mark it closed/done (filter from the default open view rather than hard-delete, preserving the repo-canonical record); on reopen, restore it. Publish an event so the PWA task list updates live.

## Triage context

### Agent - 2026-06-21T12:43:26.755Z

I dug into the code — this is a real gap, not a perception issue. The GitHub webhook handler (`apps/daemon/src/github/webhook.ts`) only classifies and acts on `issues.opened` (→ issue intake) and `issue_comment.created`. There's no branch for `issues.closed` or `issues.reopened`, so closing an issue on GitHub never reaches `github-task-store.ts` to reconcile the local task list. That matches exactly what you're seeing.

The fix is well-contained: add a `issues.closed` (and likely `reopened`) case to `classifyWebhook`/`handleGithubWebhook` that looks up the task by issue number in the github-backed store and reconciles its status — plus an `events.publish` so the open PWA task list refreshes live. The one design choice worth a moment: whether a GitHub-closed task should **disappear** from the list or **show as done/closed** (preserving it for audit, consistent with "per-project artifacts are repo-canonical"). I'd lean toward marking it closed/filtering it from the default open view rather than hard-deleting, but that's a small call inside one change.

Because this is a single missing webhook branch against an existing, well-understood seam — not something that needs decomposition — I'm routing it as a discrete task rather than a plan.

```json
{
  "kind": "task",
  "title": "Reconcile GitHub-closed issues into the Factory task list via webhook",
  "summary": "Extend the GitHub webhook handler (`apps/daemon/src/github/webhook.ts`) to handle `issues.closed` and `issues.reopened`, currently unhandled — it only acts on `issues.opened` and `issue_comment.created`.\n\nOn close, look up the task by issue number in `github-task-store.ts` and mark it closed/done (filter from the default open view rather than hard-delete, preserving the repo-canonical record); on reopen, restore it. Publish an event so the PWA task list updates live.",
  "reasoning": "The feedback names a single concrete sync gap, and the code confirms the webhook simply lacks a `closed` branch — a bounded one-seam change, not work that needs plan-level decomposition."
}
```I dug into the code — this is a real gap, not a perception issue. The GitHub webhook handler (`apps/daemon/src/github/webhook.ts`) only classifies and acts on `issues.opened` (→ issue intake) and `issue_comment.created`. There's no branch for `issues.closed` or `issues.reopened`, so closing an issue on GitHub never reaches `github-task-store.ts` to reconcile the local task list. That matches exactly what you're seeing.

The fix is well-contained: add a `issues.closed` (and likely `reopened`) case to `classifyWebhook`/`handleGithubWebhook` that looks up the task by issue number in the github-backed store and reconciles its status — plus an `events.publish` so the open PWA task list refreshes live. The one design choice worth a moment: whether a GitHub-closed task should **disappear** from the list or **show as done/closed** (preserving it for audit, consistent with "per-project artifacts are repo-canonical"). I'd lean toward marking it closed/filtering it from the default open view rather than hard-deleting, but that's a small call inside one change.

Because this is a single missing webhook branch against an existing, well-understood seam — not something that needs decomposition — I'm routing it as a discrete task rather than a plan.

```json
{
  "kind": "task",
  "title": "Reconcile GitHub-closed issues into the Factory task list via webhook",
  "summary": "Extend the GitHub webhook handler (`apps/daemon/src/github/webhook.ts`) to handle `issues.closed` and `issues.reopened`, currently unhandled — it only acts on `issues.opened` and `issue_comment.created`.\n\nOn close, look up the task by issue number in `github-task-store.ts` and mark it closed/done (filter from the default open view rather than hard-delete, preserving the repo-canonical record); on reopen, restore it. Publish an event so the PWA task list updates live.",
  "reasoning": "The feedback names a single concrete sync gap, and the code confirms the webhook simply lacks a `closed` branch — a bounded one-seam change, not work that needs plan-level decomposition."
}
```

## Acceptance

- [ ] (TBD)

