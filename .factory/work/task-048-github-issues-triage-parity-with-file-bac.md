---
id: task-048
title: GitHub-issues backend triage parity with the file backend
status: done
priority: high
estimate: medium
created: 2026-06-20T05:02:00.000Z
updated: 2026-06-20T05:02:00.000Z
labels:
  - audit
  - github-issues
---

## Source

Operator-reported during prod-usage audit (14d ending 2026-06-20). See
`tasks/audit-prod-14d-2026-06-20.md` and `docs/spec-github-issues.md` / ADR-007.

## Operator's note

When a project uses the github-issues task backend, you can still comment, but
Factory doesn't auto-triage and respond/update like it does with the local
(file) backend. It also doesn't auto-triage the bug initially when it lands in
the inbox like local tasks do.

## Root cause (traced)

The github-issues backend was never wired into either triage hook — two
independent omissions:

1. **Landing.** `runTriage` (`apps/daemon/src/triage/orchestrate.ts:190`) has
   exactly one caller: `ideasRouter.create` (`apps/daemon/src/routers/ideas.ts:36`),
   the internal DB-insert path. A GitHub issue arriving via
   `handleGithubWebhook` (`apps/daemon/src/github/webhook.ts:142`) only inserts a
   bare `kind:"issue_intake"` decision whose payload is raw issue metadata
   (`number,title,author,htmlUrl`) — no agent invoked, no `rationale`/`spec_stub`.
   So the inbox card has nothing to suggest.

2. **Comments.** `decisionsRouter.comment` rejects any kind other than `triage`/
   `blocked_run` (`apps/daemon/src/routers/decisions.ts:707`), so the follow-up
   agent (`runFollowupTriage`, `orchestrate.ts:302`) is unreachable for
   `issue_intake`. Inbound `issue_comment` webhooks are classified `processed`
   then dropped — the side-effect block only runs for `issues/opened`
   (`webhook.ts:92-113`). Spec confirms `issue_comment.*` was only ever specced
   to invalidate the task-thread cache (`docs/spec-github-issues.md:255`).

File-backed items flow through DB-insert/tRPC paths that have triage attached;
github items flow through the webhook path that doesn't.

## Agent's draft

- **Auto-triage on intake.** In `handleGithubWebhook` (`webhook.ts:142`), after
  inserting the `issue_intake` decision, fire-and-forget a triage pass on the
  issue title+body (mirror `ideas.ts:36`). Either generalize `runTriage` to
  accept an issue-sourced input, or write the agent verdict (rationale +
  spec_stub) into the decision payload so the inbox renders the suggestion.
  Thread `config` (+ agent budget) into the webhook handler —
  `githubWebhookRoute` (`webhook.ts:174`) already has `config` in scope.

- **Comment-driven response.** Relax the `decisions.ts:707` gate to allow
  `issue_intake`, and add an `issue_intake` branch in the background block
  (analogous to the `triage` branch at `decisions.ts:738`) that runs an agent
  reply and appends an `agent`-role `decisionComments` row.

- **Route inbound `issue_comment` webhooks** in `classifyWebhook`/
  `handleGithubWebhook`: resolve the issue number to its `issue_intake` decision,
  persist the GitHub comment as an operator-role comment, then invoke the same
  follow-up agent.

- **Echo agent replies back to GitHub** via `POST /issues/{n}/comments` as
  `factory[bot]` (spec §2.4/§3, `docs/spec-github-issues.md:205-212`) so the
  reply shows on the issue, not just in Factory.

- **Loop guard.** Skip `factory[bot]`-authored comments on inbound ingestion and
  don't re-post the bot's own replies (the `factory` label concept already exists,
  `webhook.ts:17,93`).

## Acceptance

- A new GitHub issue on a github-issues-backed project lands in the inbox with an
  agent triage verdict (rationale + suggested plan/task), same as file-backed
  intake — not a bare approve/dismiss card.
- Commenting on a github-issues inbox item (from Factory or from GitHub) triggers
  an agent reply that updates the thread, and the reply round-trips to the GitHub
  issue as `factory[bot]`.
- No triage/response loops from the bot's own comments.
- File-backend triage/comment behavior is unchanged (regression check).
