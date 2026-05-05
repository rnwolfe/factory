# Side cuts 2 — operator-immediacy, lifecycle, authoring, self-feedback

> Nine independently-shippable cuts grouped into four batches:
>
> **A — Lifecycle.** Close the loop on a project's endgame and its
> external-world handshake.
>
> **B — Operator-immediacy.** Less ceremony between operator and
> project: browse the code, run a dev server, drop into an ad-hoc
> Claude session.
>
> **C — Authoring.** Make prompts and rubrics editable on the same
> footing, with import/export and version history.
>
> **D — Self-feedback.** Capture feedback on Factory itself from
> within Factory; iterate on it with the agent the same way decisions
> and plans iterate. Closes the meta-loop now that cut 6 from the
> prior batch lets us import the factory repo into factory.
>
> Each cut is self-contained — pick any subset, ship in any order, but
> D2 depends on D1.
>
> Deferred (still in vision.md §7): better xterm experience inside
> sessions/runs (scrollback search, copy/paste, font sizing); cost
> budgets per project; run replay; weekly digest; rubric
> self-iteration calibration; idea-capture-from-outside-PWA. Also
> deferred: GitHub Issues as task storage (separate batch — that one
> is a wide-surface behavior change, not a contained cut).

-----

## Execution semantics for the overnight run

- Treat each cut as a separate commit-batch boundary. Don't bundle.
- Order by scope, smallest first. If the run hits a wall partway
  through, the small wins are already committed.
- Each cut has its own "done criteria"; check it before declaring the
  cut complete and moving on.
- All cuts are reversible at the commit level. Two cuts add migrations
  (D1 feedback table; D2 feedback_comments table). One cut adds a
  config field (A2 GitHub token). Both are flagged below.
- Hard guardrails (overnight-run skill rules) still apply: no force
  push, no remote operations except where the cut's own design
  requires them (A2 creates a repo on GitHub on operator-initiated
  click; tests stub this), no credential exfiltration, no destructive
  ops on shared state.
- Suggested order — small to large:
  1. **C1 — Prompt pack import/export** (smallest; pure I/O on the
     existing prompts schema).
  2. **C2 — Rubric editing + versioning** (mirrors the prompt-editing
     UX shipped in commit `314dfe0`; mostly wiring).
  3. **A1 — Project archive + delete** (lifecycle; covers two related
     UX paths in one cut — soft archive convenience and a guarded
     destructive delete).
  4. **A2 — GitHub repo creation** (operator-initiated "publish to
     GitHub"; one token in config, one POST to `/user/repos`, one
     `git remote add` + `git push`).
  5. **D1 — Feedback primitive** (capture surface + table + inbox
     entry; no agent yet).
  6. **D2 — Iterate-on-feedback with agent** (mirrors decision/plan
     thread shape; depends on D1).
  7. **B2 — Run package.json scripts** (in-memory ephemeral process
     registry; introduces the script-output WS channel that B3 reuses).
  8. **B1 — Repo browser** (read-only git over the workdir; Monaco
     viewer reuses the prompts editor's plumbing).
  9. **B3 — Ad-hoc Claude session** (largest; new `sessions` primitive
     with worktree + tmux + try-merge-on-end).

Estimated nominal effort: ~12 human-days of work. As an agent run,
that's "one long overnight" or "two if usage-limit-throttled." Worst
case: cuts 1–6 ship and 7–9 park. Re-park them and resume next session.

-----

## 1. Prompt pack import/export

### Goal

Move prompts between Factory installs (or back them up) without
hand-rolling SQL. A "prompt pack" is a single YAML file that
serializes a chosen set of prompt keys + their full version history
+ which version is active.

### Approach

Two new tRPC procedures (`prompts.export`, `prompts.import`) plus
two PWA affordances on the existing `/settings/prompts` page. No
schema changes — the `prompts` and `prompt_versions` tables already
support everything needed.

### Shape

**Schema:** none. Reuse existing.

**Daemon:**

- New `apps/daemon/src/prompts/pack.ts`:
  - `serializePack(db, opts?: { keys?: string[] })`: returns a YAML
    blob with shape:
    ```yaml
    factoryPromptPack: 1
    exportedAt: 2026-05-05T03:30:00Z
    factoryVersion: 0.4
    prompts:
      - key: triage.score
        activeVersion: 7
        versions:
          - version: 1
            body: "..."
            message: "initial seed"
            createdAt: 2026-04-01T00:00:00Z
          - version: 2
            body: "..."
            ...
    ```
  - `parsePack(yaml)`: parses + validates schema version + returns
    typed structure.
  - `applyPack(db, pack, opts: { activateImported: boolean })`:
    upserts each `(key, version)` pair on `prompt_versions`. If
    `activateImported`, the imported pack's `activeVersion` becomes
    the new active version on the destination; otherwise the
    destination's existing active version is preserved (additive
    import). Returns a per-prompt summary `{ added, skipped,
    activated }`.
- `apps/daemon/src/routers/prompts.ts` gets two new procedures:
  - `export({ keys?: string[] })` → returns `{ yaml: string }`.
  - `import({ yaml: string, activateImported?: boolean })` → returns
    the per-prompt summary.

**PWA:**

- `/settings/prompts` page header gains two buttons:
  - `[ export pack ]` — fetches the YAML, triggers a browser
    download named `factory-prompts-<date>.yaml`.
  - `[ import pack ]` — opens a file picker, reads the file
    client-side, calls `prompts.import.mutate`, then shows the
    per-prompt summary.
- Selection UI for export is deferred — v1 exports all prompts.
  (Operator-managed selection is a future polish if the prompt list
  grows.)

### Files / new modules

```
apps/daemon/src/prompts/pack.ts                 (NEW)
apps/daemon/src/routers/prompts.ts              (add export/import)
apps/daemon/test/prompts-pack.integration.test.ts  (NEW)
apps/pwa/src/routes/prompts-viewer.tsx          (add header buttons)
```

### Done criteria

- `prompts.export.query()` returns valid YAML round-trippable through
  `prompts.import.mutate({ yaml })` without state change (idempotent).
- Import-then-export of a non-empty pack on a fresh install
  reproduces the original active versions.
- Import with `activateImported: false` does NOT change the active
  version on prompts that already exist locally.
- Malformed YAML returns a clean tRPC error, not an unhandled throw.

### Open questions

- Should pack format embed prompt schema versions for forward-compat?
  Lean: yes — the `factoryPromptPack: 1` discriminator does that.
  Future bumps add a migration in `parsePack`.
- Sign packs? Out of scope — single operator, single machine, no
  trust boundary worth modeling yet.

### Estimated effort

½ day.

-----

## 2. Rubric editing + versioning

### Goal

Edit rubrics from the PWA the same way prompts are edited (commit
`314dfe0`). Versioned, with history, with activation.

### Approach

Mirror the prompt-editing pattern onto the existing `rubric_versions`
table. The schema and most of the daemon already exist; the gap is
PWA editor pages and a few activation/version-create mutations.

### Shape

**Schema:** none. `rubric_versions` already has
`(rubric_key, version)` uniqueness, `parent_version_id`, `active`,
`yaml`, `message`. No migration needed.

**Daemon:**

- `apps/daemon/src/routers/rubrics.ts` gets:
  - `list()` — already exists; keep.
  - `get({ rubricKey })` — returns active version + chronological
    history.
  - `upsertVersion({ rubricKey, yaml, message? })` — creates a new
    version with `parent_version_id` set to the current active. Does
    NOT activate.
  - `activate({ versionId })` — flips `active=true` on the chosen
    version, `active=false` on the prior active for that key.
- YAML validation: parse via `yaml` (already used elsewhere) and
  check the rubric has the expected top-level shape (axes, weights,
  etc.). On invalid YAML, refuse to insert.

**PWA:**

- New route `/settings/rubrics` — list of rubric keys with current
  active version + version count.
- New route `/settings/rubrics/:rubricKey` — Monaco editor (re-use
  the prompt editor component, pulled out into a shared
  `<MonacoYamlEditor>` if it isn't already), version history dropdown
  on the right, "save as new version" + "activate" buttons.
- Reuse the same diff-vs-active toolbar from prompts so the operator
  can see what changed before saving.

### Files / new modules

```
apps/daemon/src/rubrics/validate.ts           (NEW — shape check)
apps/daemon/src/routers/rubrics.ts            (add get/upsert/activate)
apps/daemon/test/rubrics-edit.integration.test.ts  (NEW)
apps/pwa/src/components/monaco-yaml-editor.tsx (refactor — extract from prompts)
apps/pwa/src/routes/rubrics-viewer.tsx        (NEW)
apps/pwa/src/routes/rubric-detail.tsx         (NEW)
apps/pwa/src/app.tsx                          (wire routes)
apps/pwa/src/routes/settings.tsx              (add rubrics link)
```

### Done criteria

- `/settings/rubrics` lists every distinct `rubric_key` with its
  active version number.
- Editing a rubric and clicking "save as new version" creates a new
  row with `active=false` and bumps the version number; the active
  version doesn't change until "activate" is clicked.
- "Activate" flips the active flag atomically (one row up, one row
  down — single transaction).
- Saving invalid YAML surfaces a clean error in the editor.
- The version history dropdown lets the operator load any prior
  version into the editor (read-only display).

### Open questions

- Should rubric activation also be timestamped on the rubric_versions
  row (a new `activatedAt` column)? Useful for history but adds a
  migration. Lean: skip in this cut; activation events appear in a
  future "audit log" surface.
- Should rubrics support a "revert to version N" button (creates a
  new version cloning N's body)? Lean: yes — single line in the
  upsertVersion call, cheap to add.

### Estimated effort

1 day.

-----

## 3. Project archive + delete

### Goal

End-of-life UX for projects. Two related paths:

- **Archive** (soft, reversible). Tag the project as `past`, suppress
  it from default project list rendering, but keep all data.
- **Delete** (hard, destructive). Remove the project workdir (only
  for Factory-owned workdirs under `~/.factory/projects/`), wipe its
  worktrees, cascade-delete DB rows.

### Approach

Archive is mostly already there — `tag=past` exists. This cut adds
the explicit "archive" affordance on the project header and a
filter on `/projects` so archived projects only show with an
explicit toggle. Delete is the destructive new bit; needs cascade
plumbing and a typed-confirm UX on phone.

### Shape

**Schema:** add `archivedAt` to projects (nullable integer). Set on
archive; cleared on un-archive. Used for sort order in the archive
filter so the most-recently-archived appear first. Mark this
migration as `0010_project_archived_at.sql`.

Cascade audit: walk the FK graph and confirm `ON DELETE` behavior
for every project-scoped table:

- `runs.project_id` → CASCADE
- `audits.project_id` → CASCADE
- `audit_comments.audit_id` → CASCADE (already)
- `plans.project_id` → CASCADE (nullable for spec drafts; only the
  project-bound ones cascade)
- `plan_comments.plan_id` → CASCADE (already)
- `decisions.project_id` → CASCADE
- `decision_comments.decision_id` → CASCADE (already)
- `claude_metrics.owner_*` (polymorphic) — needs an explicit cleanup
  pass since it doesn't FK to a single table. The delete path
  selects the project's run/audit/decision/plan IDs and deletes
  metrics whose `(owner_kind, owner_id)` matches.
- `events` table — same polymorphic cleanup.

If any of those don't have CASCADE today, add them in the same
migration.

**Daemon:**

- New `apps/daemon/src/projects/lifecycle.ts`:
  - `archiveProject(db, projectId)`: sets `tag='past'`,
    `archivedAt=Date.now()`. Idempotent.
  - `unarchiveProject(db, projectId)`: sets `tag='active'`,
    `archivedAt=null`.
  - `deleteProject(config, db, projectId, opts: { removeWorkdir:
    boolean })`: refuses if any run is `running`. For
    `removeWorkdir: true`, walks the project's worktrees under
    `~/.factory/worktrees/<slug>/`, removes each via
    `git worktree remove --force` then `rm -rf`, then `rm -rf`s the
    workdir itself if it lives under `config.workdir`. (Imported-by-
    path projects: the workdir is OUTSIDE `config.workdir`, so
    `removeWorkdir: true` only removes worktrees and the DB row —
    never the imported repo.) Cascade-deletes DB rows. Wraps in a
    transaction.
- `apps/daemon/src/routers/projects.ts` gets:
  - `archive({ id })` / `unarchive({ id })`.
  - `delete({ id, removeWorkdir })`.
- Both archive and delete publish an `inbox` event so any open
  `/projects` tab refreshes.

**PWA:**

- Project header: replace the `tag` chip with a `[ … ]` overflow
  menu containing "archive", "delete", and the existing tier picker
  if not promoted elsewhere.
- Archive: one-click confirm.
- Delete: typed-confirm modal — operator must type the project slug
  to enable the delete button. Shows a one-line preview of what
  will be removed (workdir path + worktree count + audit-reports-
  on-disk count).
- `/projects`: add a "show archived" toggle in the header. Default
  off. When off, projects with `tag='past'` are hidden.

### Files / new modules

```
packages/db/src/migrations/0010_project_archived_at.sql  (NEW)
apps/daemon/src/projects/lifecycle.ts                    (NEW)
apps/daemon/src/routers/projects.ts                      (add archive/delete)
apps/daemon/test/project-lifecycle.integration.test.ts   (NEW)
apps/pwa/src/components/project-overflow-menu.tsx        (NEW)
apps/pwa/src/components/delete-project-modal.tsx         (NEW)
apps/pwa/src/routes/project-detail.tsx                   (wire menu)
apps/pwa/src/routes/projects.tsx                         (archive filter)
```

### Done criteria

- Archiving a project hides it from the default `/projects` view;
  toggling "show archived" surfaces it.
- Un-archiving restores it to `active`.
- Delete with `removeWorkdir: true` for a Factory-owned workdir
  leaves no trace under `~/.factory/projects/<slug>/` or
  `~/.factory/worktrees/<slug>/`.
- Delete with `removeWorkdir: true` for a path-imported workdir
  removes worktrees but leaves the imported repo intact.
- Cascade DB cleanup is verified by an integration test that creates
  runs, audits, audit_comments, plans, plan_comments, decisions,
  metrics, events, then deletes the project and asserts all of
  those are gone.
- A project with a `running` run cannot be deleted (refuses with
  PRECONDITION_FAILED).
- Delete is denied if the typed slug doesn't match (PWA-side guard).

### Open questions

- Should delete soft-mark (set `deletedAt`) before the actual rm, so
  the UI can show "deleting…" and the rm runs in a background task?
  Lean: no — synchronous delete is simpler and the rm is fast on
  reasonably sized projects. If a project has gigabytes of node_modules
  in worktrees, the operator can wait.
- What about audit reports committed to the project repo before
  deletion? They go away with the workdir for owned projects, stay
  for imported ones. No off-disk archive. If the operator wants
  audit reports preserved, they should approve them (which writes
  them into the project repo's `docs/internal/audits/`) before
  deleting the project.

### Estimated effort

1 day.

-----

## 4. GitHub repo creation

### Goal

From a Factory project, click a button to create a new GitHub repo
and push the project's history to it. Operator-initiated (not
automatic on bootstrap). One-shot per project.

### Approach

Operator stores a GitHub PAT in Factory config (`auth.githubToken`).
A "publish to GitHub" affordance on the project header opens a small
modal: org / personal, visibility (public/private), repo name (defaults
to project slug). Submitting calls `POST https://api.github.com/user/repos`
(for personal) or `POST /orgs/<org>/repos` (for org), then `git remote
add origin <clone-url>` + `git push -u origin main` in the project
workdir. Stores the resulting `githubRemote` on the project row.

### Shape

**Schema:** add `githubRemote` (text, nullable) to projects. Stores
the SSH or HTTPS clone URL. No migration if drizzle-kit can ALTER
TABLE in place; otherwise a small migration `0011_project_github_remote.sql`.

**Config:** add `auth.githubToken: string | null` to FactoryConfig
in `apps/daemon/src/config.ts`. Loaded from `~/.factory/config.yaml`.
Token is mode-600-protected via the existing config-file permission
check.

**Daemon:**

- New `apps/daemon/src/projects/github.ts`:
  - `createRepo({ token, owner: 'user' | { org: string }, name,
    private, description? })`: POSTs to the GitHub API, returns the
    new repo's clone URL + html URL. Handles 422 (name conflict) and
    401 (bad token) explicitly with typed errors.
  - `pushToNewRemote({ workdirPath, remoteUrl, gitAuthor })`:
    `git remote add origin <url>` + `git push -u origin main`.
    Disables credential prompts (`GIT_TERMINAL_PROMPT=0`); auth is
    handled by encoding the token in the HTTPS URL for push:
    `https://<token>@github.com/...`. The `git remote add` stores the
    plain URL (no token) so `git push` from the operator's terminal
    later doesn't have an embedded token.
  - The token-in-URL trick for push is a one-shot: the daemon
    constructs the auth URL only for the initial push, never
    persists it.
- `apps/daemon/src/routers/projects.ts` gets:
  - `publishToGithub({ id, owner, name, private, description? })` —
    calls createRepo + pushToNewRemote, sets
    `projects.githubRemote`, returns the repo's html URL. Refuses
    if `githubRemote` is already set (operator must manually clear
    or re-link via a separate path).

**PWA:**

- Project header gains a "publish to GitHub" button when
  `githubRemote` is null AND `auth.githubToken` is configured (the
  daemon exposes a `settings.hasGithubToken` query).
- When `githubRemote` is set, the button is replaced by a small chip
  linking to the repo's html URL.
- Settings page gets a "GitHub" section with a token input (masked,
  uses an existing-token placeholder when set).

### Files / new modules

```
packages/db/src/migrations/0011_project_github_remote.sql  (NEW or extend 0010)
apps/daemon/src/projects/github.ts                         (NEW)
apps/daemon/src/routers/projects.ts                        (add publishToGithub)
apps/daemon/src/routers/settings.ts                        (add github token endpoints)
apps/daemon/src/config.ts                                  (githubToken field)
apps/daemon/test/github-publish.integration.test.ts        (NEW — uses fetch mock)
apps/pwa/src/components/publish-github-modal.tsx           (NEW)
apps/pwa/src/routes/project-detail.tsx                     (wire button + chip)
apps/pwa/src/routes/settings.tsx                           (token input)
```

### Done criteria

- With a token configured, "publish to GitHub" creates a real public
  repo on the operator's account (or a chosen org), pushes main,
  and stores the remote URL on the project row.
- The chip linking to the repo appears after success.
- Without a token, the button is hidden and the modal explains how
  to add one.
- 401/422 errors from GitHub surface as readable error messages in
  the modal (not as an opaque tRPC error code).
- The token-in-URL push doesn't leave the token in `.git/config`
  (`git config --get remote.origin.url` returns the plain HTTPS or
  SSH URL).
- Re-publishing an already-published project is refused.
- Tests use a `fetch` mock for the GitHub API; the actual HTTP call
  is exercised manually by the operator on first use.

### Open questions

- SSH vs HTTPS for the stored remote URL? Lean: HTTPS, since that's
  what works with token push. Operator can switch to SSH afterward
  via `git remote set-url`.
- Multiple GitHub accounts? Out of scope — single operator, single
  token, no profile switcher.
- Auto-publish on bootstrap/import-success? Considered, rejected:
  operator-initiated keeps the network action explicit and means a
  bad token doesn't tank the bootstrap flow.

### Estimated effort

1 day.

-----

## 5. Feedback primitive

### Goal

Capture short-form feedback on Factory itself from anywhere in the
PWA. Up/down vote + a short text body, with the current route
captured automatically. Surfaces in the home inbox alongside
decisions, plans, and audits.

This cut is *only* the capture + storage + inbox surface. Iterating
on feedback with the agent is D2.

### Approach

A `feedback` table holds rows. A small floating-action button (FAB)
in the PWA shell opens a one-screen drawer with up/down + text. The
drawer auto-captures the current route's pathname + a short
"context hint" derived from the route (e.g., "audit-pane: <auditId>",
"plan-detail: <planId>"). Submitting persists the row and shows a
small "thanks — feedback captured" toast.

The home inbox gets a new card type for feedback rows in `open`
status, sorted by createdAt alongside the existing inbox items.

### Shape

**Schema:** new `feedback` table. Migration `0012_feedback.sql`:

```sql
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  vote TEXT NOT NULL CHECK (vote IN ('up','down')),
  body TEXT NOT NULL,
  contextRoute TEXT,
  contextHint TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER,
  resolvedTarget TEXT  -- 'plan:<id>' | 'task:<projectId>:<taskId>' | null
);
CREATE INDEX feedback_status_created_idx ON feedback (status, createdAt);
```

**Daemon:**

- New `apps/daemon/src/feedback/store.ts`:
  - `appendFeedback(db, { vote, body, contextRoute, contextHint })`:
    inserts a row, returns it. Publishes an `inbox` event with
    `kind: 'feedback_created'`.
  - `setFeedbackStatus(db, feedbackId, status, opts?: { resolvedTarget })`.
  - `listOpenFeedback(db)`: rows with `status IN ('open',
    'in_progress')`, ordered by createdAt desc.
- New `apps/daemon/src/routers/feedback.ts`:
  - `submit({ vote, body, contextRoute?, contextHint? })`.
  - `inbox()` — open + in_progress, for the home inbox.
  - `get({ id })` — full row (used by D2's detail page).
  - `dismiss({ id })`, `resolve({ id, resolvedTarget? })` — status
    transitions.
- Wire into `apps/daemon/src/router.ts`.

**PWA:**

- New `apps/pwa/src/components/feedback-fab.tsx`: floating button
  bottom-right (above the existing tab bar's safe-area inset).
  Tapping opens a `<FeedbackDrawer>`.
- New `apps/pwa/src/components/feedback-drawer.tsx`: bottom-sheet
  drawer with up/down toggle, textarea (1000 char max), submit/cancel.
  Auto-fills `contextRoute` from `useLocation().pathname` and
  `contextHint` from a small `routeHint(pathname)` helper.
- The home inbox component gets a new card type rendering a feedback
  row: vote chip, first line of body, context hint, age. Tapping
  navigates to the feedback detail page (added in D2 — for D1, it
  navigates to a stub page that just renders the body and a
  "dismiss" button).
- Wire `useScopedChannel` (cut 2 from the prior batch) to invalidate
  `["feedback.inbox"]` on `feedback_created` and `feedback_updated`.

### Files / new modules

```
packages/db/src/migrations/0012_feedback.sql            (NEW)
packages/db/src/schema.ts                               (add feedback table)
apps/daemon/src/feedback/store.ts                       (NEW)
apps/daemon/src/routers/feedback.ts                     (NEW)
apps/daemon/src/router.ts                               (wire feedbackRouter)
apps/daemon/src/events.ts                               (add feedback_* event variants)
apps/daemon/test/feedback-store.integration.test.ts     (NEW)
apps/pwa/src/components/feedback-fab.tsx                (NEW)
apps/pwa/src/components/feedback-drawer.tsx             (NEW)
apps/pwa/src/components/shell.tsx                       (mount the FAB)
apps/pwa/src/routes/feedback-detail.tsx                 (NEW — stub for D1)
apps/pwa/src/routes/inbox.tsx                           (render feedback cards)
apps/pwa/src/app.tsx                                    (wire route)
```

### Done criteria

- Tapping the FAB on any screen opens the drawer.
- Submitting persists a `feedback` row and the toast appears.
- The new row appears in the home inbox immediately (via the WS
  event, not just on next poll).
- Dismissing from the stub detail page transitions the row to
  `dismissed` and removes it from the inbox.
- Mobile (390px) layout: FAB doesn't cover existing nav targets;
  drawer is full-width with one-handed reach.

### Open questions

- Should feedback capture include a screenshot? Tempting but
  invasive (camera/screen-capture permission, attachment storage).
  Skip in v1; the contextHint string is enough.
- Should the FAB be hidden when the operator is in a high-attention
  context (active audit, live run pane)? Lean: no — feedback is
  most useful exactly there.

### Estimated effort

1 day.

-----

## 6. Iterate on feedback with agent (depends on D1)

### Goal

A feedback row is not a final artifact — it's a starting point for a
back-and-forth that produces either a plan (work to do) or a task in
the factory project, or gets dismissed. This cut adds the agent
thread on a feedback row and the promote-to-plan / promote-to-task
flow.

### Approach

Feedback gets the same thread shape as decisions, plans, and audits:
operator and agent rows in a `feedback_comments` table, "thinking"
placeholder when last row is operator, MarkdownView per body. The
agent's role: read the operator's feedback + context, ask clarifying
questions, draft a plan or recommend a task. The operator decides
when to "promote" the conversation to a real plan or task.

The promote target requires Factory's own repo to be imported as a
project (operator does this once via cut 6 from the prior batch).
A new config field `factoryProjectId` records which project is the
meta-target. If unset, "promote" is disabled with a clear "import
the factory repo first" hint.

### Shape

**Schema:** new `feedback_comments` table, mirrors `audit_comments`.
Migration `0013_feedback_comments.sql`:

```sql
CREATE TABLE feedback_comments (
  id TEXT PRIMARY KEY,
  feedbackId TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('operator','agent')),
  body TEXT NOT NULL,
  resultingDraft TEXT,  -- nullable JSON snapshot of the agent's draft, if any
  createdAt INTEGER NOT NULL
);
CREATE INDEX feedback_comments_feedback_created_idx ON feedback_comments (feedbackId, createdAt);
```

**Config:** add `factoryProjectId: string | null` to FactoryConfig.
Editable from settings. PWA refuses promote when null.

**Daemon:**

- New `apps/daemon/src/feedback/iterate.ts`: same shape as
  `apps/daemon/src/audits/comments.ts` from the prior batch.
  - `appendOperatorComment(db, feedbackId, body)`.
  - `runAgentReply(config, db, feedbackId, operatorBody)`: invokes
    `claude --print` with a feedback-specific prompt that includes
    the original feedback body, contextRoute, contextHint, and the
    full thread history. Resumes the feedback's captured
    `claudeSessionId` (new column on `feedback`, nullable text).
    The agent's reply is parsed; if it includes a fenced JSON block
    declaring a `plan_draft` or `task_draft`, the parsed draft is
    stored on the comment's `resultingDraft`.
- New `apps/daemon/src/feedback/promote.ts`:
  - `promoteToPlan(db, feedbackId)`: creates a `feature_plan` plan
    on the configured `factoryProjectId`, seeds with the agent's
    last `resultingDraft` (or a stub if none), marks feedback
    `status='resolved'` + `resolvedTarget='plan:<id>'`.
  - `promoteToTask(db, feedbackId)`: creates a task in the factory
    project's `.factory/work/` via the existing `createTask` seam.
    Marks feedback `status='resolved'` + `resolvedTarget='task:<projectId>:<taskId>'`.
- `apps/daemon/src/routers/feedback.ts` extends:
  - `comments({ feedbackId })`.
  - `comment({ feedbackId, body })` — operator post + background
    agent reply.
  - `promoteToPlan({ feedbackId })`.
  - `promoteToTask({ feedbackId })`.
- `apps/daemon/src/routers/settings.ts` (existing or NEW) adds
  `setFactoryProjectId({ projectId | null })` and
  `getFactoryProjectId()`.

**PWA:**

- Replace the D1 stub at `/feedback/:id` with a real
  `<FeedbackDetail>` page:
  - Header: vote chip, status, age.
  - Body: original feedback + context.
  - Thread: same shape as `decision-detail.tsx` (operator/agent
    rows, MarkdownView per body, "thinking" placeholder).
  - Actions: "promote to plan" / "promote to task" / "dismiss" /
    "resolve" buttons. Promote buttons are disabled with a tooltip
    when `factoryProjectId` is unset.
- Settings: a "factory meta-project" picker — drop-down listing
  current projects; select one to set `factoryProjectId`.
- Wire `useFeedbackChannel(feedbackId, [...])` for live updates,
  reusing the cut-2 pattern.

### Files / new modules

```
packages/db/src/migrations/0013_feedback_comments.sql       (NEW)
packages/db/src/schema.ts                                   (add feedback_comments + claudeSessionId on feedback)
apps/daemon/src/feedback/iterate.ts                         (NEW)
apps/daemon/src/feedback/promote.ts                         (NEW)
apps/daemon/src/feedback/prompts.ts                         (NEW — system prompt for feedback iteration)
apps/daemon/src/routers/feedback.ts                         (extend)
apps/daemon/src/routers/settings.ts                         (factory project id endpoints)
apps/daemon/src/config.ts                                   (factoryProjectId field)
apps/daemon/test/feedback-iterate.integration.test.ts       (NEW — stubs invokeClaudeJson)
apps/pwa/src/lib/channels.ts                                (add useFeedbackChannel)
apps/pwa/src/routes/feedback-detail.tsx                     (REWRITE — full thread UI)
apps/pwa/src/routes/settings.tsx                            (factory project picker)
```

### Done criteria

- Posting an operator comment on a feedback row triggers the agent
  reply via `claude --print` (or its stub in tests).
- The agent's reply lands as an `agent`-role row; the thread renders
  identical to plan/decision/audit threads.
- "Promote to plan" with `factoryProjectId` set creates a
  `feature_plan` plan on the factory project, seeded with the
  agent's last draft. Operator lands on the new plan's detail page.
- "Promote to task" creates a markdown file in the factory project's
  `.factory/work/`, visible in the project's task list.
- Both promote actions transition the feedback row to `resolved`
  with the appropriate `resolvedTarget`.
- Without `factoryProjectId` set, both promote buttons are
  disabled and the settings link is offered instead.

### Open questions

- Should the agent's first reply be auto-fired on feedback creation
  (no operator comment needed), or only after the operator opens
  the row + comments? Lean: only after operator engagement. Auto-
  reply on every up/down vote burns tokens on noise.
- Should the agent have read access to the factory repo when
  iterating on factory feedback? It runs against the current
  project's workdir if one's set; the factory project being the
  current target gives it that access. Yes.
- Plan vs task — should the agent recommend which? Yes — reuse the
  promote-findings bridge prompt shape from
  `apps/daemon/src/audits/promote.ts`.

### Estimated effort

1.5 days.

-----

## 7. Run package.json scripts

### Goal

From a project, click a script (from `package.json`'s `scripts`),
spawn it, and stream its output to a live pane. Detect URLs and
ports in the output and surface them as clickable chips. "Stop"
button kills the process. Survives over a long-running dev server.

### Approach

In-memory ephemeral process registry — no DB row. Spawning a process
returns a handle id; output streams to a new WebSocket channel
`/ws/script/:id`. Handle is killed on "stop" or on daemon shutdown.
URL detection runs over a sliding tail buffer.

This cut introduces the script-output WS channel that B3 (ad-hoc
session) reuses.

### Shape

**Schema:** none. Scripts are ephemeral.

**Daemon:**

- New `apps/daemon/src/scripts/registry.ts`:
  - `ScriptRegistry` class — `Map<scriptHandleId, RunningScript>`.
  - `RunningScript`: `{ id, projectId, scriptName, command, proc,
    startedAt, tailBuffer, urlsDetected, ws }`.
  - `start(...)`: spawns via `bunSpawn`, hooks stdout/stderr into
    the tail buffer, fires URL-detection regex, broadcasts to
    subscribers.
  - `stop(id)`: kills via SIGTERM; if alive after 5s, SIGKILL.
- New `apps/daemon/src/scripts/url-detect.ts`:
  - Regex for `https?://[^\s]+`, plus a softer `localhost:\d+`
    matcher that infers `http://localhost:N`.
  - Deduped per-handle; the registry stores the set.
- New `apps/daemon/src/scripts/package-scripts.ts`:
  - `readPackageScripts(workdirPath)`: reads `package.json`, returns
    `{ scriptName, command }[]`. If the project has no
    `package.json`, returns `[]`.
- New `apps/daemon/src/routers/scripts.ts`:
  - `listAvailable({ projectId })` — script names from package.json.
  - `start({ projectId, scriptName })` — returns handle id. Refuses
    if a script with the same name is already running for this
    project (one of each at a time; operator stops the first to
    start a new one).
  - `active({ projectId? })` — currently running scripts.
  - `stop({ id })` — kill.
- New WS channel `/ws/script/:id`: bytes mode, mirrors `/ws/pane`
  for runs. Authentication via the existing bearer token.

**PWA:**

- New route `/projects/:id/scripts/:scriptId` — script live pane.
  - Header: project + script name + status (running / exited / failed).
  - URL chips: each detected URL renders as a chip; tapping opens
    in a new tab (mobile: in the browser).
  - Output: same xterm.js renderer used by run live-pane,
    subscribed to `/ws/script/:scriptId`.
  - Stop button.
- Project header: a "scripts" button that lists available scripts
  in a dropdown; selecting one calls `start` and navigates to the
  script live pane.
- A small "running scripts" indicator on `/projects/:id` if any
  scripts are active for that project.

### Files / new modules

```
apps/daemon/src/scripts/registry.ts                  (NEW)
apps/daemon/src/scripts/url-detect.ts                (NEW)
apps/daemon/src/scripts/package-scripts.ts           (NEW)
apps/daemon/src/routers/scripts.ts                   (NEW)
apps/daemon/src/router.ts                            (wire)
apps/daemon/src/server.ts                            (wire /ws/script/:id)
apps/daemon/test/scripts-registry.test.ts            (NEW)
apps/daemon/test/scripts-url-detect.test.ts          (NEW)
apps/pwa/src/routes/script-pane.tsx                  (NEW)
apps/pwa/src/components/scripts-menu.tsx             (NEW)
apps/pwa/src/routes/project-detail.tsx               (wire menu + indicator)
apps/pwa/src/app.tsx                                 (wire route)
```

### Done criteria

- For a project with `bun run dev` defined, clicking "scripts → dev"
  spawns the dev server in the project workdir and streams output.
- Detected localhost URLs appear as chips within ~2s of the dev
  server logging them.
- "Stop" terminates the process (SIGTERM → SIGKILL fallback at 5s).
- Daemon shutdown (`kill -TERM`) cleanly stops all running scripts.
- A subsequent `start({ scriptName: 'dev' })` after stop succeeds
  (no zombie state).
- Output buffer caps at ~200 KB tail to bound memory.

### Open questions

- Where does the script run — workdir HEAD or a worktree? Lean:
  workdir HEAD. Dev servers need `node_modules` and other workdir-
  rooted state; running from a worktree means re-installing deps
  every time. Risk: if a code-changing run is also operating on the
  workdir's worktree (separate path), there's no conflict — the
  scripts run on the project's checked-out main HEAD.
- Should we offer environment variable overrides from the PWA when
  starting? E.g., `PORT=3001`. Out of scope for v1; operator can
  edit `package.json` or set in shell config.
- Persist running scripts across daemon restarts? No — dev servers
  don't survive the daemon process restart anyway, and re-attaching
  would require a much larger PID-tracking effort.

### Estimated effort

1.5 days.

-----

## 8. Repo browser

### Goal

A read-only GitHub-style code browser inside the PWA, scoped to a
project's workdir. Branches, commit history, file tree, file viewer
with syntax highlighting via Monaco.

### Approach

All read paths go through `git` shells against the project workdir
— no file I/O directly. Tree and blob queries take a `ref` (branch,
tag, sha, or `HEAD`) so the browser can navigate through history,
not just the current checkout. Phone-first design: vertical lists
over side-by-side panes; breadcrumb-driven navigation.

### Shape

**Schema:** none. All queries are derived live from the workdir.

**Daemon:**

- New `apps/daemon/src/projects/repo-read.ts`:
  - `listBranches(workdirPath)`: `git for-each-ref refs/heads/
    --format=...`. Returns name, last commit sha, last commit subject,
    last commit timestamp, ahead/behind from the project's main.
  - `listCommits(workdirPath, ref, opts: { limit, cursor? })`:
    `git log --format=... -n <limit> <cursor-args> <ref>`. Returns
    sha, subject, author, timestamp. Cursor is `--skip` based.
  - `listTree(workdirPath, ref, path)`: `git ls-tree <ref>:<path>`.
    Returns entries with type (blob | tree | symlink), name, size
    (for blobs), mode.
  - `readBlob(workdirPath, ref, path)`: `git show <ref>:<path>`.
    Caps at 5 MB and rejects with a typed error otherwise. Returns
    `{ content, encoding: 'utf8' | 'binary' }` — binary check on
    null-byte content.
- New `apps/daemon/src/routers/repo.ts`:
  - `branches({ projectId })`.
  - `commits({ projectId, ref?, limit?, cursor? })`.
  - `tree({ projectId, ref, path })`.
  - `blob({ projectId, ref, path })` — text or `{ binary: true,
    sizeBytes }` for binary.
- All five endpoints validate `projectId`, refuse paths with `..`
  components or absolute paths, and refuse ref strings containing
  characters outside `[A-Za-z0-9._/-]` (rejects shell injection
  attempts even though we use `git`'s safe argv form).

**PWA:**

- New route `/projects/:id/code` — root, defaulting to HEAD tree.
  Mobile-first single-column layout with breadcrumbs.
- Sub-routes (handled via search params, not nested routes, to
  preserve scroll/state on back):
  - `?tab=tree&ref=<ref>&path=<path>` — file tree at ref.
  - `?tab=commits&ref=<ref>` — commit log.
  - `?tab=branches` — branch list.
  - `?tab=blob&ref=<ref>&path=<path>` — file viewer.
- File viewer: reuse `<MonacoYamlEditor>` from the rubrics cut
  (extracted in C2) with `readOnly: true` and language inferred
  from extension. For very long files (>100 K lines), display a
  "file too large" placeholder with a "view raw" link to the daemon
  endpoint.
- Branch picker: a top-bar dropdown showing the current ref;
  changing it updates the URL's `ref` param.

### Files / new modules

```
apps/daemon/src/projects/repo-read.ts                (NEW)
apps/daemon/src/routers/repo.ts                      (NEW)
apps/daemon/src/router.ts                            (wire)
apps/daemon/test/repo-read.integration.test.ts       (NEW)
apps/pwa/src/routes/repo-browser.tsx                 (NEW)
apps/pwa/src/components/repo-tree.tsx                (NEW)
apps/pwa/src/components/repo-commits.tsx             (NEW)
apps/pwa/src/components/repo-branches.tsx            (NEW)
apps/pwa/src/components/repo-blob.tsx                (NEW)
apps/pwa/src/components/repo-breadcrumb.tsx          (NEW)
apps/pwa/src/components/ref-picker.tsx               (NEW)
apps/pwa/src/lib/lang-from-extension.ts              (NEW — Monaco language map)
apps/pwa/src/routes/project-detail.tsx               (wire "code" link in header)
apps/pwa/src/app.tsx                                 (wire route)
```

### Done criteria

- `/projects/:id/code` lists the project's HEAD tree.
- Tapping a directory navigates into it; breadcrumbs update.
- Tapping a file opens the Monaco viewer with the right syntax
  highlighting (verified for `.ts`, `.tsx`, `.md`, `.yaml`,
  `.json`, `.css`, `.html`, `.py` at minimum).
- Switching branches reloads the tree at the chosen ref.
- The commit log paginates ("load more" button) without losing
  scroll position on back navigation.
- Files over 5 MB or detected-binary show the appropriate
  placeholder, not garbled bytes.
- Path traversal attempts (`?path=../../etc/passwd`) are rejected
  by the daemon-side guard.

### Open questions

- Commit graph rendering vs flat list? Lean: flat list. A real
  graph (parents → children with branch lines) is a non-trivial
  layout problem; flat ordered list with sha + subject covers
  90% of "what happened recently."
- Diff viewer between two commits? Skip in this cut; add as a
  follow-on. Requires a diff-rendering surface and is its own UX
  concern.
- Image / SVG previews in the file viewer? Skip — Monaco can show
  the raw text, and binary files show the placeholder. Image
  preview is its own polish cut.
- Symlinks? Render with a chip indicator, follow on tap (single-hop
  only — refuse to dereference deeper to avoid loops).

### Estimated effort

2 days.

-----

## 9. Ad-hoc Claude session (worktree-based)

### Goal

Operator wants to drop into a Claude session against a project
without going through the run flow's plan-task-prompt structure.
Open a session, type freely, exit when done. Commits made during
the session try to merge into main like a regular run.

### Approach

A new `sessions` primitive that reuses the existing tmux + worktree
infrastructure. A session creates a `factory/adhoc-<sessionId>`
worktree off main, attaches an interactive `claude` (no
`--print`, no headless flags), pipes the tmux pane to the existing
`/ws/pane` channel, and on exit handles commits the same way runs
do (try-merge into main, fail surfaces a merge_failure decision).

The contract: a session IS a kind of run, but with no factory-status
footer (since there's no completion to declare), no quality checks,
and no auto-advance. It does still get auto-merge on clean exit.

### Shape

**Schema:** new `sessions` table. Migration `0014_sessions.sql`:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','ended','merged','merge_failed','aborted')),
  branchName TEXT NOT NULL,
  worktreePath TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  commitCount INTEGER NOT NULL DEFAULT 0,
  mergedAt INTEGER,
  mergeError TEXT
);
CREATE INDEX sessions_project_started_idx ON sessions (projectId, startedAt);
```

**Daemon:**

- New `apps/daemon/src/sessions/orchestrate.ts`:
  - `startSession(config, db, { projectId })`: creates a worktree at
    `factory/adhoc-<sessionId>`, starts a tmux session there,
    spawns interactive `claude` (no `--print`, no
    `--dangerously-skip-permissions` in v1 — operator drives, so
    permission prompts hit them), inserts the sessions row.
    Returns session id + WS pane URL.
  - `endSession(config, db, sessionId)`: detaches tmux, counts
    commits on the branch (`git rev-list main..<branch>`), if any
    exist runs the same `mergeIntoMain` flow used by runs. On
    success: sets `status='merged'`, publishes a `session_ended`
    event. On merge conflict: sets `status='merge_failed'`, creates
    a `merge_failure` decision (existing primitive — reused).
  - `abortSession(config, db, sessionId)`: kills the tmux session
    without merging; sets `status='aborted'`. Branch and commits
    stay on disk; operator can inspect or clean up later.
- New `apps/daemon/src/routers/sessions.ts`:
  - `start({ projectId })`.
  - `end({ id })` — graceful merge attempt.
  - `abort({ id })` — kill without merge.
  - `list({ projectId })` — recent sessions.
  - `get({ id })` — detail.
- The runtime's existing tmux abstraction is reused; sessions don't
  need a new transport.

**PWA:**

- New route `/projects/:id/sessions/:sessionId` — session live pane.
  - Reuses the run live-pane's xterm.js subscription to `/ws/pane?id=<sessionId>`.
  - Status header: running / ended / merged / merge_failed /
    aborted. Time elapsed.
  - Buttons: "end session" (merge if commits exist) / "abort"
    (no merge).
  - When status is `merge_failed`: a banner linking to the
    merge_failure decision card.
- Project header: an "ad-hoc session" button. Tapping starts a new
  session and navigates to its pane. Disabled if a session is
  already `running` for this project.
- Project detail page: a "sessions" section listing recent sessions
  with their merge status.

### Files / new modules

```
packages/db/src/migrations/0014_sessions.sql              (NEW)
packages/db/src/schema.ts                                 (add sessions table)
apps/daemon/src/sessions/orchestrate.ts                   (NEW)
apps/daemon/src/sessions/merge.ts                         (NEW or extract from runner.ts)
apps/daemon/src/routers/sessions.ts                       (NEW)
apps/daemon/src/router.ts                                 (wire sessionsRouter)
apps/daemon/src/events.ts                                 (add session_* event variants)
apps/daemon/src/workers/recover.ts                        (handle stale running sessions on daemon start)
apps/daemon/test/sessions-orchestrate.integration.test.ts (NEW)
apps/pwa/src/routes/session-pane.tsx                      (NEW)
apps/pwa/src/components/sessions-list.tsx                 (NEW)
apps/pwa/src/routes/project-detail.tsx                    (wire button + section)
apps/pwa/src/app.tsx                                      (wire route)
```

### Done criteria

- Clicking "ad-hoc session" on a project starts a session, opens
  its pane, and the operator gets an interactive claude prompt
  inside the worktree.
- Editing files + committing during the session lands those
  commits on the `factory/adhoc-<sessionId>` branch.
- "End session" with no commits cleans up the worktree and marks
  `status='ended'` with `commitCount=0`.
- "End session" with commits triggers `mergeIntoMain`; on success
  status is `merged`, project main has the new commits.
- "End session" with a conflict marks `merge_failed` and creates a
  `merge_failure` decision card. Branch and commits stay on disk.
- "Abort" kills tmux without merging; branch + commits stay on disk.
- Daemon restart while a session is running: on next start, the
  recover sweep marks orphaned `running` sessions as `aborted`
  (their tmux is gone with the daemon).
- Two concurrent sessions on different projects work; two on the
  same project are refused.

### Open questions

- `--dangerously-skip-permissions` for ad-hoc sessions? Lean: NO.
  The architectural contract in CLAUDE.md exists because
  code-changing runs are non-interactive; sessions ARE interactive
  and the operator can grant permissions in real-time. Permission
  prompts are a feature, not friction.
- What if the operator runs `git checkout main` inside the session?
  The worktree boundary protects the project's main checkout
  (different path), but the session's branch tip would shift.
  Documented in the session pane's footer; not specially guarded
  against — operator owns the consequences.
- Bare shell mode (no claude, just zsh)? Tempting and trivially
  cheap to add — same orchestration without the `claude` spawn.
  Lean: include it in this cut as a `mode: 'claude' | 'shell'`
  parameter on `start({...})`. PWA only exposes `claude` mode for
  now; `shell` mode is exercised via direct tRPC for the
  occasional escape hatch.
- Session name / description? Useful for the sessions list. Add a
  nullable `description: TEXT` column on the migration.

### Estimated effort

2 days.

-----

## What we're explicitly NOT doing in this batch

Listed once so the overnight run doesn't pick them up by accident:

- **GitHub Issues as task storage** (the bigger half of the
  GitHub ideas). Wide-surface behavior change at the `tasks.ts`
  storage seam — needs its own batch with a careful
  online/offline/conflict design.
- **Cost budgets per project.** Need a few weeks of metrics data
  first.
- **Run replay.** Cheap and useful but no day-to-day pain yet.
- **Diff viewer in the repo browser.** Add as a follow-on cut once
  the read-only browser is in operator's hands and the actual
  diff-viewing pain manifests.
- **Better xterm experience** (scrollback search, copy/paste, font
  sizing). Cut 3 from the prior batch reduced time-on-xterm; B3
  reintroduces it for ad-hoc sessions but doesn't polish the
  ergonomics. Polish goes in its own cut.
- **Multi-account GitHub auth.** One token, one operator.
- **Prompt pack signing / attestation.** Single-operator trust
  boundary doesn't justify it.
- **Session image / file attachments on feedback.** D1's text +
  context route is enough for v1.
- **Auto-trigger feedback iteration.** D2 only fires the agent
  when the operator opens the row and posts a comment — passive
  votes don't burn tokens.

-----

## Schema migration summary

Five new migrations across the batch. Grouped here for cross-
reference:

| # | Migration | Cuts | Reversible? |
|---|-----------|------|-------------|
| 0010 | `project_archived_at` | A1 (cut 3) | Yes — column drop |
| 0011 | `project_github_remote` | A2 (cut 4) | Yes — column drop |
| 0012 | `feedback` | D1 (cut 5) | Yes — table drop |
| 0013 | `feedback_comments` | D2 (cut 6) | Yes — table drop |
| 0014 | `sessions` | B3 (cut 9) | Yes — table drop |

If the run hits a wall mid-batch and a migration has been applied
but the cut wasn't completed, the migration stays — empty table is
harmless. The next run picks up where it left off.

-----

## Final check

Each cut, in order, before declaring done:

```sh
bun run typecheck
bun run check
bun test
bun run --filter '@factory/pwa' build
git add <files-for-this-cut>
git commit -m "feat(...): cut <N> — <title>"
# move to next cut
```

End-of-batch check (before writing the morning report):

```sh
git status                         # must be clean
git log --oneline main..HEAD       # the morning's narrative
bun run typecheck && bun run check && bun test
```

If a cut fails its done-criteria check: do not move on. Diagnose,
fix or revert the cut's commit, log the decision, then either
continue with the cut fixed or skip it cleanly (don't leave
partial state).
