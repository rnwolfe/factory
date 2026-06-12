# ADR-007 — GitHub Issues as a canonical task backend, with a first-class Factory bot identity

**Status:** Accepted (design; implementation pending — see `docs/spec-github-issues.md`)
**Date:** 2026-06-12
**Deciders:** Ryan Wolfe

---

## Context

Factory's GitHub integration today stops at repo publication: a project can
push to a new GitHub repo (`projects.publishToGithub` → `apps/daemon/src/projects/github.ts`),
the clone URL is stored on `projects.github_remote`, and origin is reconciled
on import. Tasks live as local markdown-with-frontmatter files in
`<project>/.factory/work/<id>-<slug>.md`, read and written exclusively through
`apps/daemon/src/projects/tasks.ts` — the single point of truth that every
task entry point (bootstrap, `+task`, refinement/feature-plan freeze,
audit-finding promote, feedback promote, template instantiate) routes through.

Both that module's header comment and `docs/vision.md` §6.2 explicitly name a
future swap to GitHub Issues as "a one-file change at each seam." This ADR
takes that swap, and goes two steps further than a storage swap:

1. The operator wants the issue **comment thread** to be first-class context
   that travels with the task — into the run prompt, the PWA, retries, and
   writeback — not just the issue title/body.
2. The operator surfaced that Factory has **no real GitHub actor**. Its commits
   land under a dangling string author (the `git author` setting) that GitHub
   cannot link to any account. Adding issues makes this visible: issues would
   publish under the operator's identity (PAT) while commits stay ownerless.

Identity is therefore not an issue-specific nicety — it is a foundational layer
that improves commit attribution on every published repo. It is decided here
because commit history attributed under one identity cannot be re-attributed
later; retrofitting leaves a split-brain history.

---

## Decisions

### D1 — GitHub Issues become a canonical task store, per-project opt-in, behind the `tasks.ts` seam

A new project field `projects.task_backend ∈ {file, github-issues}` (default
`file`). `github-issues` is selectable only when the project has a
`github_remote` and the Factory App is installed on that repo. For an opted-in
project, **the issue _is_ the task**: the issue body holds the same YAML
frontmatter + markdown body the local file does today, so the task remains
human-legible and survives Factory being wiped (the §6.2 "repo is canonical"
principle — strengthened, since Issues are more durable and collaborator-legible
than local files).

The seam is realized as a `TaskStore` interface; `tasks.ts` dispatches on the
project's backend:

```ts
interface TaskStore {
  list(): Promise<TaskFile[]>
  read(id): Promise<TaskFile | null>
  create(input): Promise<TaskFile>
  updateStatus(id, status): Promise<TaskFile>
  updateModel(id, model): Promise<TaskFile>
  updateBody(id, body): Promise<TaskFile>
}
function taskStoreFor(project): TaskStore // FileTaskStore | GithubIssuesStore
```

`TaskFile` / `TaskFrontmatter` types are unchanged, so the 7 callers move from
`createTask(path, …)` to `taskStoreFor(project).create(…)` and nothing
downstream shifts. **Task id = the GitHub issue number** for github-backed
projects (no mapping table; `task-<n>` branch/commit naming still works).
File-backed projects keep `task-NNN`. A project is exactly one backend, so the
id schemes never collide.

GitHub has only open/closed, so the richer Factory status round-trips through
the issue body frontmatter + a `status:*` label:

| Factory status | GitHub representation |
|---|---|
| ready / in_progress / review / blocked | **open** + `status:<x>` label + frontmatter |
| done | **closed**, `state_reason: completed` |
| dropped | **closed**, `state_reason: not_planned` |

Reconciliation is bidirectional: a manual close → done/dropped (by reason); a
reopen → ready; a body edit → re-parse frontmatter.

### D2 — A two-identity model; the bot identity is a GitHub App ("Factory")

Factory writes to GitHub under two distinct identities, split along human vs.
machine:

- **Operator identity** = the existing `github-token` PAT. Used for the
  operator's own actions: publishing the repo, and thread replies the operator
  authors from the PWA. These should look like the operator.
- **Bot identity** = a registered **GitHub App, "Factory"**. Used for machine
  actions: commits, push/merge, run-result writebacks, the agent's surfaced
  questions, status labels, and Factory-authored issues. These should look like
  `factory[bot]`, never the operator.

The daemon authenticates as the App by minting a JWT (RS256, signed with the
App private key), exchanging it for a per-installation access token
(`POST /app/installations/{id}/access_tokens`, ~1h TTL, cached and refreshed),
and using that token for REST writes and as the git push credential
(`x-access-token:<token>`). Commits attribute to the bot by setting the run
worktree's `user.name = factory[bot]` and
`user.email = <bot-user-id>+factory[bot]@users.noreply.github.com` (the bot's
numeric user id is resolved once and cached) — the same mechanism by which
`github-actions[bot]` commits attribute. This replaces the string-author git
config for all runs, not only issue-backed projects.

The App was chosen over a dedicated bot account + PAT for: an unmistakable
`[bot]` identity, fine-grained per-repo permissions, higher rate limits, no
long-lived shared secret, a single app-level webhook (see D5), and a path to
verified commits. Cost accepted: app registration, private-key storage, and
installation-token refresh machinery in the daemon.

### D3 — The issue comment thread is first-class task context

For a github-backed task, the issue's comment thread is the task's living
discussion and travels with it:

- **Read → run prompt.** At run-submit, the thread is fetched fresh and
  rendered as a delimited *Discussion* section in the task portion of the
  prompt — reusing the mechanism that folds blocked-run operator replies in as
  an "Operator notes" preamble (`runs.operator_context`). **All comments are
  auto-folded regardless of author.** The section is wrapped in explicit
  untrusted-input delimiters carrying provenance (author + whether they hold
  write access); this labels the source but does not gate it. The per-run
  worktree (with `--dangerously-skip-permissions`) remains the actual
  blast-radius boundary — the operator accepted the prompt-steering surface
  this opens for a single-operator setup on their own repos.
- **Display → PWA.** Task-detail renders the thread inline (the github-backed
  analog of `plan_comments` / feedback threads); the operator can reply from
  Factory (authored under the operator identity, D2).
- **Write → comments.** Factory posts run-completion summaries (with merge/PR +
  commit refs) and the agent's surfaced questions (`blocked_run` /
  `agent_decision`) as comments, so collaborators answer in the thread and
  their replies become next-run context. Status transitions ride on labels, not
  a comment each, to keep threads quiet.

This is the first concrete instance of the `vision.md` §7 "unify the feedback
thread into one shape" idea. Per the "don't generalize before the second
instance" discipline, it is **not** generalized beyond github-backed tasks
here.

### D4 — Externally-authored issues enter via the inbox, not as silent tasks

A `issues.opened` event for an issue Factory did **not** author (detected via
the absence of the `factory` label / App authorship) creates an `issue_intake`
decision in the inbox: *promote to task* / *dismiss*. Approving adopts the
existing issue as a task (PATCH frontmatter + `factory` + `status:ready`
labels). This preserves the "inbox is the only attention sink" contract and
prevents unattended external input from driving agent runs.

### D5 — Sync via the App's webhook, with a poll-on-read backstop

A GitHub App has a single app-level webhook that receives events for every repo
it is installed on, so no per-repo webhook registration is needed — the App is
the ingress. The daemon exposes `POST /webhooks/github` (HMAC-verified against
the App webhook secret), reached publicly via the `expose-service` tunnel
(`*.labs.rwolfe.io`). Handled events: `issues.*`, `issue_comment.*`,
`installation*`. Because webhooks can be missed (daemon down), a poll-on-read
reconcile (when listing a project's tasks) stays as a backstop.

### D6 — Phasing

1. **Identity foundation.** Register the App; daemon installation-token auth;
   run worktrees commit + push as `factory[bot]`. Independent of issues;
   delivers real commit attribution immediately.
2. **Issue backend + thread.** `GithubIssuesStore`, `task_backend` opt-in +
   backfill, status/label mapping, thread → prompt + PWA display + writeback.
   Lands the App webhook for issues/comments.
3. **Intake + live sync.** `issue_intake` inbox decisions, full `issues.*` /
   `issue_comment.*` reconciliation, ingress hardening.

---

## Architectural contracts established / touched

- **Task storage is provider-pluggable.** `tasks.ts` no longer assumes the
  filesystem; `taskStoreFor(project)` is the seam. New task entry points must
  route through it (unchanged rule, now backend-agnostic).
- **One Factory bot identity for all machine writes.** Commits, pushes, issues,
  and comments by machine actions attribute to `factory[bot]`; operator-authored
  actions attribute to the operator. Do not author machine commits/comments
  under the operator identity.
- **Issue thread is untrusted input, delimited, but not gated** (github-backed
  tasks). The worktree sandbox is the boundary; do not weaken it on the
  assumption that comment content is trusted.
- **External issues are inbox-gated**, never silent tasks. Preserves
  inbox-as-only-attention-sink.

## Consequences

**Positive**
- Real, consistent GitHub identity for machine work across commits and issues;
  commit attribution improves on every published repo.
- Tasks become collaborator-legible and Factory-independent (Issues survive a
  DB wipe more robustly than local files).
- Inbound/outbound/writeback collapse into one backend because the issue is the
  task and the thread is the context.

**Negative / Limitations**
- Network + App installation become hard dependencies for github-backed
  projects; `tinker`/local projects are untouched (stay `file`).
- Locally-made commits attribute to the bot but are **Unverified** unless later
  routed through the Git Data API for signing (deferred).
- Status is lossy at the GitHub boundary (open/closed); fidelity depends on the
  `status:*` label + frontmatter round-trip surviving manual edits.
- Auto-folding all comments is a prompt-steering surface, mitigated only by the
  worktree sandbox and provenance labeling.
- Installation-token refresh and webhook ingress add operational surface
  (private key, tunnel, HMAC secret).

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| Issues **mirror** file-canonical tasks | Two stores + conflict resolution to maintain; fights the "one-file swap" design |
| Dedicated bot account + PAT | Simpler, but a long-lived shared secret, reads as a normal user not `[bot]`, no app-level webhook, lower limits |
| PAT + per-repo registered webhooks | The App centralizes a single webhook; per-repo registration is redundant once the App is chosen |
| External issues auto-become ready tasks | Lets unattended external input drive agent compute; violates inbox-as-only-attention-sink |
| Trusted-author-only comment folding | Operator chose maximal context; per-run worktree is the accepted boundary |
| Defer the App to a later phase (PAT first) | Commit history can't be re-attributed later; identity must be decided before any commits land |
