# Side cuts — between v0.4 spec and v0.4 implementation

> Five independently-shippable cuts pulled from `vision.md` §7. Drafted
> as the implementation plan for an overnight autonomous run while
> v0.4's marinate scheduler waits on more audit-severity signal.
> Each cut is self-contained — pick any subset, ship in any order.
>
> Deferred (still in vision.md §7): better terminal experience in the
> PWA (xterm scrollback, copy/paste, font sizing); project archive /
> delete; cost budgets per project; run replay; weekly digest;
> rubric self-iteration calibration; idea-capture-from-outside-PWA.

-----

## Execution semantics for the overnight run

- Treat each cut as a separate commit-batch boundary. Don't bundle.
- Order by scope, smallest first. If the run hits a wall partway
  through, the small wins are already committed.
- Each cut has its own "done criteria"; check it before declaring the
  cut complete and moving on.
- All cuts are reversible at the commit level. No migrations live in
  these except where flagged.
- Hard guardrails (overnight-run skill rules) still apply: no force
  push, no remote operations, no credentials, no destructive ops on
  shared state.
- Suggested order:
  1. Worktree cleanup (smallest)
  2. Reactivity (medium, foundational — makes everything else feel
     tighter)
  3. Run log formatting (medium, high daily value)
  4. Unified feedback (audit comments → thread) (medium)
  5. External project onboarding (largest, do last so an unfinished
     state doesn't strand the others)

-----

## 1. Worktree cleanup

### Goal

Operator-facing visibility into what's on disk under
`~/.factory/worktrees/`, plus a way to delete worktrees that are no
longer wanted. Today they accumulate forever.

### Approach

A new `worktrees` tRPC router exposing list + delete, plus a small
admin surface in the PWA. No auto-cleanup policy in this cut — just
manual visibility. (Auto-cleanup is a follow-on once the operator has
a sense of accumulation rate.)

### Shape

**Daemon:**

- New `apps/daemon/src/projects/worktree-list.ts`:
  - `listWorktrees(config)`: walks `~/.factory/worktrees/<slug>/<runId>/`
    — for each, gathers size (du-style sum), `mtime`, branch (read
    `.git` or `git -C ... rev-parse --abbrev-ref HEAD`), associated
    `runId` (the directory name), and existence of an associated run
    row (so we know whether it's "orphaned" — run row deleted but
    worktree remained).
  - `removeWorktreeAt(path)`: shells out `git worktree remove --force`
    against the parent project repo, then `rm -rf` if the directory
    survived. Errors propagate.
- New `apps/daemon/src/routers/worktrees.ts`:
  - `list` — returns the snapshot above, sorted by size desc.
  - `delete({ path })` — guards: must be under
    `config.worktreesRoot`, must not be the active worktree of a
    `running` run.

**PWA:**

- New route `/settings/worktrees` linked from the existing settings
  page (under "agent" or a new "storage" section).
- Each row shows: project slug, runId (short), branch, size (MB),
  age, "orphaned" chip if no run row, "active" chip if a `running`
  run holds it. Delete button per row, confirmation modal.

### Files / new modules

```
apps/daemon/src/projects/worktree-list.ts   (NEW)
apps/daemon/src/routers/worktrees.ts        (NEW)
apps/daemon/src/router.ts                   (mount worktrees router)
apps/pwa/src/routes/worktrees.tsx           (NEW)
apps/pwa/src/app.tsx                        (wire route)
apps/pwa/src/routes/settings.tsx            (add link)
```

### Done criteria

- `/settings/worktrees` shows every worktree under `~/.factory/worktrees/`.
- Sizes are computed correctly (test with a known-sized worktree).
- Delete on a non-active worktree removes both the git worktree pointer
  and the directory; the row disappears on refetch.
- Attempting to delete the worktree of a `running` run returns a
  `PRECONDITION_FAILED` error.
- `bun run typecheck`, `bun run check`, `bun test` all pass.

### Open questions

- Should we surface worktree storage at the **project** level too
  (a "disk: 1.2 GB across 8 worktrees" line on project header)?
  Lean: yes, cheap to add once `listWorktrees` exists. Include in
  this cut if time allows.

-----

## 2. Reactivity

### Goal

Replace 4-8 second polling on per-entity pages with WebSocket-pushed
React Query invalidations. Operator sees state change within ~100ms of
the daemon committing it instead of "up to N seconds later."

### Approach

Today only `/ws/inbox` pushes invalidations (and only for inbox-shaped
events). Extend the existing `EventBus` to a single `/ws/events`
endpoint that accepts a `scope` filter via query params, e.g.
`?scope=project:<id>` or `?scope=run:<id>` or `?scope=audit:<id>`. The
PWA grows small per-route hooks (`useProjectChannel(projectId)`, etc.)
that open the right scoped socket and call `qc.invalidateQueries` on
matching events.

This is **not** a pub-sub refactor of the daemon. The EventBus already
fans events to subscribers; we add filtering at the WS edge.

### Shape

**Daemon:**

- `apps/daemon/src/index.ts` (WS routing): add a `/ws/events?scope=<...>`
  handler that subscribes to the EventBus and forwards events whose
  `projectId` / `runId` / `auditId` matches the scope. Authentication
  via the existing token query param.
- `apps/daemon/src/events.ts`: events already carry `projectId` /
  `runId` / `auditId` on most kinds. Audit a few that don't and add
  the field where needed.

**PWA:**

- New `apps/pwa/src/lib/use-channel.ts` — small hook factory that
  opens the scoped socket, manages reconnect with backoff, and exposes
  an `onEvent` callback. Internal helper.
- New `apps/pwa/src/lib/channels.ts` — typed wrappers:
  `useProjectChannel(projectId, queryKeys)`,
  `useRunChannel(runId, queryKeys)`,
  `useAuditChannel(auditId, queryKeys)`.
  Each takes an array of React Query key prefixes to invalidate when
  *any* event arrives on that channel. Coarse but cheap.
- Wire into routes:
  - `/projects/:id` — `useProjectChannel(id, [["runs.list", id], ["plans.list", id], ["audits.list", id], ["projects.workdir", id]])` and bump those queries' `refetchInterval` to a slow fallback (30s instead of 4s).
  - `/projects/:id/runs/:runId` — `useRunChannel(runId, [["runs.get", runId], ["runs.events", runId]])`.
  - `/projects/:id/audits/:auditId` — `useAuditChannel(auditId, [["audits.get", auditId]])`.

### Files / new modules

```
apps/daemon/src/index.ts                   (extend WS routing)
apps/daemon/src/events.ts                  (audit fields on events)
apps/pwa/src/lib/use-channel.ts            (NEW)
apps/pwa/src/lib/channels.ts               (NEW)
apps/pwa/src/routes/project-detail.tsx     (mount channel + lower poll)
apps/pwa/src/routes/live-pane.tsx          (mount channel + lower poll)
apps/pwa/src/routes/audit-pane.tsx         (mount channel + lower poll)
apps/pwa/src/routes/plan-detail.tsx        (mount channel + lower poll)
```

### Done criteria

- Open `/projects/:id` in two browsers; trigger an event in one (start
  a run, freeze a plan, install a skill) — the other reflects the
  change within ~1s without a manual refresh.
- Polling intervals on the affected pages drop to 30s+ as a safety
  net (so a missed WS message still resolves eventually).
- Network tab shows one persistent WS connection per scoped page,
  and at-most-one outstanding tRPC query when an event arrives.
- Reconnect-on-disconnect works: kill the daemon, restart it; the WS
  reconnects with backoff.

### Open questions

- Coarse vs fine invalidation: a single "any event on this scope →
  invalidate everything in queryKeys" is cheap. Per-event-kind
  routing (only invalidate runs list when a run event arrives) is
  better but more code. Lean: coarse for v1, fine if it's noisy.
- Should the operator see a "live" indicator (a small dot on the
  shell header showing WS connected)? Lean: yes, tiny mono dot in
  the header. Cheap, communicates the model.

-----

## 3. Run log formatting

### Goal

Replace the raw stream-json dump in the live pane with a structured,
readable event timeline. Tool calls become "Bash: <command>" rows;
assistant text renders as markdown; commits show as chip rows;
iteration boundaries become section headers. The xterm raw view
remains as a "raw" toggle for debugging.

### Approach

The runtime already emits structured `StreamEvent`s
(`apps/daemon/src/workers/runner.ts` line ~200) that get pushed to
`/ws/events`. The PWA today subscribes to `/ws/pane` (raw bytes) for
xterm. Adding a new subscriber for `/ws/events` and rendering events
as cards is the whole change.

### Shape

**No daemon changes.** The events are already structured — the runtime
already calls `agent.parseLine()` and forwards each event with `runId`
and `iteration`. Reactivity (cut 2) will deliver them via the scoped
channel.

**PWA:**

- New `apps/pwa/src/components/run-event-stream.tsx`:
  - Subscribes to `/ws/events?scope=run:<runId>`.
  - Maintains a list of received events in component state. Older
    events scroll off after a configurable cap (default 500) so the
    list doesn't grow unbounded for long-running runs.
  - Renders per-event-kind components:
    - `text` → `<MarkdownBlock>` rendering assistant text. Use a
      small markdown renderer (`marked` or our own minimal one). Keep
      it lightweight.
    - `tool` → `<ToolRow>` showing icon + name + truncated arg
      summary. Distinct color per tool family (Read/Edit/Write,
      Bash, Glob/Grep, etc.).
    - `commit` → `<CommitChip>` showing short sha + subject.
    - `iteration_start` / `iteration_end` → section divider.
    - `agent_exit` → terminal banner with exit code.
    - `metrics` → tiny chip "$0.18 · 4.2k tok · 23s".
    - `decision_required` → blocking card (already styled in v0.1).
    - `idle_timeout`, `session`, `raw` → hide (or surface as small
      mono notes in dev mode).
- Update `apps/pwa/src/routes/live-pane.tsx`:
  - Default view: `<RunEventStream />`.
  - Toggle button `[raw]` (top right) shows the existing xterm view.
  - When the run reaches a terminal status, persist the last 500
    events from the `/ws/events` history endpoint as a fallback if
    the live socket is disconnected. (`runs.eventsSince` already
    exists, so re-use it.)

**No new dependencies needed.** Markdown rendering can be a tiny
hand-rolled renderer that handles only what assistant text actually
produces (paragraphs, bullets, code fences, inline code). If we want
proper rendering, `marked@13` is ~30 kB gzipped — acceptable.

### Files / new modules

```
apps/pwa/src/components/run-event-stream.tsx       (NEW)
apps/pwa/src/components/run-event-row.tsx          (NEW — the per-kind renderers)
apps/pwa/src/components/markdown-block.tsx         (NEW — small md → react)
apps/pwa/src/routes/live-pane.tsx                  (default view + raw toggle)
```

### Done criteria

- Open a live run; assistant text renders as styled markdown, not as
  raw stream-json.
- Tool calls show as one-line rows with file path / command in mono.
- Commits and iteration boundaries are visually distinct.
- The `[raw]` toggle still shows xterm with the original byte stream.
- Long runs (500+ events) don't OOM the page; oldest events roll off.
- Disconnecting and reconnecting mid-run preserves the prior history
  (loaded from `runs.eventsSince`) and resumes live tail.

### Open questions

- Markdown library: hand-roll vs marked. Lean: hand-roll a 100-LoC
  renderer that handles paragraphs, code fences, inline code, bullet
  lists, and bold/italic. Avoids a 30 kB dep for a constrained subset.
  If quality is poor, swap to marked.
- ANSI color codes in tool output (Bash stdout especially): xterm
  handles them automatically; the structured view will need either to
  strip ANSI or convert to spans. Lean: strip in v1, convert later.

-----

## 4. Unified feedback (audit comments → thread)

### Goal

Bring audit comments up to the same shape as decision and plan
comments — a real comment table with operator and agent rows, not the
current "append markdown to the report" approach. Closes the gap that
makes audit follow-ups feel ad-hoc compared to plan iteration and
decision threads.

### Approach

This is **not** a generalized "thread" abstraction across all
primitives. It's targeted: audits get an `audit_comments` table with
the same shape as `decision_comments` and `plan_comments`. The audit
pane renders the thread; the agent reply is a thread row, not a
markdown append. The bridge (promote findings) and the audit pane
comment box both produce thread rows.

The decision and plan thread shapes can stay as-is. If a future
generalization makes sense, having three structurally identical tables
makes that easier; we don't pay for it now.

### Shape

**Schema (migration 0009):**

```typescript
export const auditCommentRoleEnum = ["operator", "agent"] as const;

export const auditComments = sqliteTable(
  "audit_comments",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .references(() => audits.id)
      .notNull(),
    role: text("role", { enum: auditCommentRoleEnum }).notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_comments_audit_created_idx").on(t.auditId, t.createdAt)],
);
```

**Daemon:**

- `apps/daemon/src/routers/audits.ts`:
  - Replace the existing `comment` mutation: write an
    `operator`-role thread row, kick off the agent reply (existing
    `--resume` flow), persist the agent reply as an `agent`-role
    thread row instead of appending to `reportMarkdown`.
  - New `comments` query: `audits.comments({ auditId })` → returns
    rows ordered by `createdAt`.
  - The `reportMarkdown` field stops accruing follow-up sections —
    the report is the report, the thread is the thread.

**PWA:**

- `apps/pwa/src/routes/audit-pane.tsx`: render the thread under the
  report, identical visual shape to plan-detail's comments.
- Keep the existing comment input box, point it at the new mutation.

### Backward compatibility

Existing audits whose `reportMarkdown` already contains
`## Discussion — operator (...)` sections from the v0.3 path: leave
the markdown as-is; future comments go to the thread. Optionally a
one-time migration that lifts those sections into thread rows — but
this is a small enough corpus (one operator, weeks of data) that
hand-cleaning if desired is fine.

### Files / new modules

```
packages/db/src/schema.ts                          (audit_comments table)
packages/db/src/migrations/0009_audit_comments.sql (NEW)
apps/daemon/src/audits/comments.ts                 (NEW — thread IO)
apps/daemon/src/routers/audits.ts                  (replace comment mutation, add comments query)
apps/pwa/src/routes/audit-pane.tsx                 (thread render)
```

### Done criteria

- Posting an operator comment on a completed audit creates an
  `audit_comments` row with `role='operator'`.
- The agent reply lands as a row with `role='agent'` (resumed claude
  session as before; metrics still record per cut 5 of v0.3).
- The audit pane renders the full thread chronologically.
- The audit `reportMarkdown` is no longer mutated by the comment flow.
- Pre-existing audits show their old markdown-appended discussion
  (no regression for prior data).
- Migration 0009 applies cleanly; `bun run typecheck`, `bun run check`,
  `bun test` all pass.

### Open questions

- Do we need a `claudeSessionId` on `audit_comments` rows for
  per-comment session tracking? Lean: no — the audit row already
  carries `claudeSessionId` (most recent), and that's the resume
  source for the next comment.
- Should the inbox surface unread audit comments as their own card
  kind? Lean: no — the audit card already covers it; new comments
  bump the card via the existing `audit_updated` event.

-----

## 5. External project onboarding

### Goal

Bring an existing repo into Factory without going through
triage→bootstrap. Two intake modes: **clone from URL** (Factory clones
into `~/.factory/projects/<slug>`) and **adopt local path** (operator
points Factory at an existing checkout).

### Approach

A new `projects.import` mutation that handles both modes, plus a PWA
route that walks the operator through the inputs and (optionally)
hands off to the existing deepening flow afterward.

### Shape

**Daemon:**

- New `apps/daemon/src/projects/import.ts`:
  - `importFromUrl(config, db, { url, name?, slug?, goal, tier })`:
    `git clone <url> <projectsRoot>/<slug>`, validates the result is a
    git repo with at least one commit, creates the `projects` row,
    creates `.factory/` skeleton.
  - `importFromPath(config, db, { path, name?, slug?, goal, tier })`:
    validates `path` exists and is a git repo, creates the `projects`
    row pointing at that path, creates `.factory/` skeleton (if
    missing — does not clobber existing).
  - Slug allocation: derive from URL (last path segment, sanitized) or
    directory name; collision-check against existing project slugs and
    suffix `-2` etc.
- New `apps/daemon/src/routers/projects.ts` mutation `import`:

  ```typescript
  .input(z.object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("url"), url: z.string().url() }),
      z.object({ kind: z.literal("path"), path: z.string().min(1) }),
    ]),
    name: z.string().min(1).max(80).optional(),
    slug: z.string().min(1).max(60).optional(),
    goal: z.enum(goalEnum),
    tier: z.enum(tierEnum).optional().default("tinker"),
  }))
  .mutation(...)
  ```

  Returns the new project row; the PWA navigates to
  `/projects/<id>` (or `/projects/<id>/deepen` if tier ≥ personal).

**PWA:**

- New route `/projects/import` with a small form:
  - Source picker: URL or local path
  - URL field (validated as URL) or path field (validated as
    absolute, exists)
  - Name (auto-fills from URL/path), slug (auto-fills, editable)
  - Goal (radio: me / learn / share / productize)
  - Tier (radio: tinker / personal / share / productize)
  - "Import" button → navigates to project page on success
- New "import existing project" button on `/projects` next to the
  existing "new idea" path.

### Safety guards

- Reject URLs that aren't `https://` or `git@`. No file URLs.
- Reject paths outside the operator's home directory unless an
  explicit allowlist env var is set.
- The clone runs in a child process with a 5-minute timeout — large
  repos shouldn't hang the daemon. (Use `bunSpawn` with abort signal,
  same pattern as triage.)
- If clone fails, remove the partial directory before returning the
  error.

### `.factory/` skeleton

```
<workdir>/
├── .factory/
│   ├── work/                  # task files (empty — no plans yet)
│   ├── audits/                # audit skill installs (empty)
│   └── runs/                  # per-run logs (empty)
└── (existing repo files unchanged)
```

The skeleton write **never** touches existing files. If the directory
already has CLAUDE.md, README.md, etc., they're left alone. The
deepening flow handles VISION.md authoring later.

### Files / new modules

```
apps/daemon/src/projects/import.ts             (NEW)
apps/daemon/src/routers/projects.ts            (add import mutation)
apps/pwa/src/routes/import-project.tsx         (NEW)
apps/pwa/src/app.tsx                           (wire route)
apps/pwa/src/routes/projects.tsx               (add "import" button)
```

### Done criteria

- `projects.import({ source: { kind: "url", url: "https://github.com/<x>" }, ... })`
  clones the repo and creates a project row pointing at it.
- `projects.import({ source: { kind: "path", path: "/abs/local/repo" }, ... })`
  registers the existing repo without copying.
- The new project shows up at `/projects/<id>` with workdir snapshot,
  task list (empty), and an empty audit section.
- Re-importing an already-imported path returns a clear error
  (not a silent overwrite).
- Bad inputs (non-git path, unreachable URL) return clean errors with
  no orphaned directories.
- A 5-minute clone timeout aborts the daemon-side child process and
  cleans up.

### Open questions

- Should imported projects auto-trigger the deepening flow when tier
  ≥ personal? Lean: nudge but don't force — show a small banner on
  the new project page suggesting `/projects/<id>/deepen`.
- Worktree base for imported projects: same as bootstrap (default to
  HEAD); per-run branches still go under
  `~/.factory/worktrees/<slug>/<runId>` regardless of where the
  workdir lives.
- Authentication for private clones: out of scope for v1. Operator
  uses a path-based import for private repos until we add SSH key /
  token plumbing.

-----

## What we're explicitly not doing in this batch

Listed once so the overnight run doesn't pick them up by accident:

- Better terminal experience inside xterm (scrollback search, copy/
  paste, font sizing). The structured event stream (cut 3) reduces
  time-on-xterm; revisit ergonomics after.
- Project archive / delete. Will become urgent later, not now.
- Cost budgets per project. Need a few weeks of cost data first.
- Run replay. Cheap and useful but no day-to-day pain yet.
- Weekly digest / external idea capture / rubric self-iteration —
  still in `vision.md` §7.
- Generalized "thread" abstraction across primitives. Cut 4 unifies
  audit comments to the same *shape* as decisions/plans without
  introducing a shared abstraction.

-----
