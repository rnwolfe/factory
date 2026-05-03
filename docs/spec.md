# Factory v0.1 — Specification

> **Status:** Draft, ready for build
> **Owner:** Ryan
> **Audience:** Implementation-time Claude Code sessions; future Ryan reviewing decisions
> **Scope:** v0.1 only — the smallest end-to-end loop that proves the architecture

-----

## 1. Vision (one paragraph)

Factory is a single-user, server-resident daemon plus a mobile-first PWA that turns a stream of ideas into a portfolio of running projects, executed by coding agents under loose human supervision. The operator (Ryan) writes ideas down anywhere, taps decisions on his phone, and lets the factory carry the rest. The factory has dominion over a working directory on a dedicated server, spawns projects, manages git worktrees, runs agents in tmux sessions, surfaces decisions back to the operator, and iterates. v0.1 ships the spine: idea → triage → spawn → run → tag. Everything else is post-v0.1.

-----

## 2. Goals & Non-Goals

### 2.1 Goals (v0.1)

- One operator can submit an idea from a phone in <30 seconds.
- The factory triages every idea against a versioned rubric and produces a decision card.
- Approved ideas spawn real projects with real git history and real agent activity.
- The operator can watch a running agent live from anywhere on their phone.
- The operator can tag any project at any time without ceremony.
- The factory survives daemon restarts, agent crashes, and overnight runs without supervision.
- The PWA looks and feels production-grade from the first commit.

### 2.2 Non-Goals (v0.1)

- Multi-user. Single operator, single auth token.
- GitHub or any external issue tracker. Project work tracking is local files.
- Container sandboxing. Host mode only.
- Multiple agent providers. Claude Code only.
- Multiple goals or quality tiers. `me` + `tinker` only.
- Rubric self-iteration. Rubric is hand-edited or seed-replaced.
- Multi-agent or parallel-project orchestration on the same project.
- In-factory rubric/prompt IDE (Monaco). Edits via filesystem until v0.2.
- Service on-ramps (Stripe, Neon, Vercel).
- Cross-project memory layer. Per-project state only.
- Auto-shelving. Tagging stays manual.

-----

## 3. Architecture

### 3.1 Topology

```
┌─────────────────────────────────────────────────────────────┐
│ Dedicated Server                                             │
│                                                              │
│  ┌────────────────────┐         ┌───────────────────────┐    │
│  │ factory-pwa        │ HTTPS   │ factoryd (daemon)     │    │
│  │ (static, served by │ tRPC +  │ Bun + TypeScript      │    │
│  │  daemon)           │ WS      │                       │    │
│  └────────────────────┘ ──────► │  ┌─────────────────┐  │    │
│         ▲                       │  │ tRPC server     │  │    │
│         │ phone / laptop        │  │ (HTTP)          │  │    │
│         │ (bearer token)        │  └─────────────────┘  │    │
│                                 │  ┌─────────────────┐  │    │
│                                 │  │ WS hub          │  │    │
│                                 │  │ (relay + events)│  │    │
│                                 │  └─────────────────┘  │    │
│                                 │  ┌─────────────────┐  │    │
│                                 │  │ Worker pool     │  │    │
│                                 │  │ @factory/runtime│  │    │
│                                 │  └─────────┬───────┘  │    │
│                                 └────────────┼──────────┘    │
│                                              │               │
│  ┌─── SQLite (drizzle) ──────────────────────┘               │
│  │   ~/factory/data.db                                       │
│  │                                                           │
│  ┌─── Workdir dominion ──────────────────────────────────┐   │
│  │   ~/factory/projects/                                  │   │
│  │     project-abc/                                       │   │
│  │       .git/                                            │   │
│  │       .factory/    (work, runs, scaffold)              │   │
│  │       worktrees/   (per-task)                          │   │
│  │     project-def/                                       │   │
│  │       ...                                              │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─── tmux sessions ─────────────────────────────────────┐   │
│  │   factory/<project-slug>/<run-id>                      │   │
│  └────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Components

- **`factoryd`** — long-running Bun daemon. Hosts the tRPC API, the WebSocket hub, and the worker pool. Single process, supervised workers within it.
- **`factory-pwa`** — React + Vite SPA. Served as static assets by the daemon. Communicates over tRPC + WebSocket.
- **`@factory/runtime`** — internal package. Owns agent invocation, worktree management, tmux integration, event emission. ~500-700 LoC of TypeScript, no Effect, no global signal handlers.
- **`@factory/db`** — internal package. Drizzle schema, migrations, query helpers.
- **`@factory/shared`** — internal package. Types shared between daemon and PWA.

### 3.3 Process Model

A single `factoryd` Bun process. Inside it:

- One tRPC HTTP server.
- One WebSocket server (multiplexed channels by URL path).
- A **worker pool** abstraction that schedules `Run`s. Each `Run` is an async task with its own `AbortController`. The pool enforces a configurable concurrency cap (default 4 for v0.1).
- A **tmux supervisor** that owns the lifecycle of tmux sessions associated with active runs.
- Signal handling lives only in the daemon’s top-level entry. `SIGTERM` / `SIGINT` triggers graceful shutdown: stop accepting new work, signal `AbortController`s, await active runs to finish their current iteration, persist state, exit. No nested `process.exit` calls anywhere.

Why one process and not separate daemon + worker processes for v0.1: simpler, sufficient for ~4 concurrent runs, and easier to debug. If we hit scaling pressure post-v0.1, the worker pool already abstracts the seam to lift workers into child processes.

-----

## 4. Stack

|Layer          |Choice                     |Notes                                                           |
|---------------|---------------------------|----------------------------------------------------------------|
|Daemon language|TypeScript on Bun          |Native fetch, WebSocket, SQLite. No Node dep.                   |
|API protocol   |tRPC v11                   |Typed end-to-end. Bun-compatible adapter.                       |
|Realtime       |Native WebSocket (Bun)     |Channels via path-based routing.                                |
|Database       |SQLite + Drizzle ORM       |`bun:sqlite` driver.                                            |
|Migrations     |Drizzle Kit                |Generated migrations checked into repo.                         |
|PWA framework  |React 18 + Vite            |Static SPA, no SSR.                                             |
|Styling        |Tailwind v4                |JIT, no PostCSS config drift.                                   |
|Components     |shadcn/ui + Radix          |Owned, not consumed.                                            |
|Icons          |lucide-react               |                                                                |
|State          |Zustand + TanStack Query   |Server state via Query, UI state via Zustand.                   |
|Live pane      |xterm.js                   |Renders tmux output.                                            |
|Forms          |react-hook-form + zod      |                                                                |
|Routing        |react-router               |                                                                |
|Agent runtime  |`@factory/runtime` (custom)|Patterns from sandcastle, our implementation.                   |
|Agent CLI      |Claude Code (`claude`)     |Subscription auth via host’s existing creds.                    |
|Multiplexer    |tmux 3.x+                  |Per-run named sessions, `pipe-pane` to socket.                  |
|Auth (v0.1)    |Single bearer token        |Stored on PWA in `localStorage`, sent in `Authorization` header.|
|Deploy         |systemd unit               |`factoryd.service` on the dedicated server.                     |
|Reverse proxy  |Caddy (recommended)        |TLS termination, single virtual host.                           |

-----

## 5. Data Model

### 5.1 Daemon State (SQLite via Drizzle)

All tables use `cuid2` IDs unless noted. All timestamps are integer Unix milliseconds.

```ts
// packages/db/schema.ts (sketch — final names in implementation)

export const ideas = sqliteTable("ideas", {
  id: text("id").primaryKey(),         // cuid2
  rawText: text("raw_text").notNull(),
  goalHint: text("goal_hint", { enum: ["me","learn","share","productize"] }),
  source: text("source").notNull(),    // "pwa", "future:cli", etc.
  createdAt: integer("created_at").notNull(),
  triagedAt: integer("triaged_at"),
});

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["triage","tag_change"] }).notNull(),
  ideaId: text("idea_id").references(() => ideas.id),
  projectId: text("project_id").references(() => projects.id),
  rubricVersionId: text("rubric_version_id").references(() => rubricVersions.id),
  outcome: text("outcome").notNull(),  // "greenlit","parked","trashed","decompose","tag:active",...
  payload: text("payload", { mode: "json" }).notNull(), // structured agent output
  uncertainty: real("uncertainty"),    // 0..1
  weightedScore: real("weighted_score"),
  status: text("status", { enum: ["pending","actioned","dismissed"] }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  actionedAt: integer("actioned_at"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),    // url-safe, derived from name
  name: text("name").notNull(),
  ideaId: text("idea_id").references(() => ideas.id),
  goal: text("goal", { enum: ["me","learn","share","productize"] }).notNull(),
  tier: text("tier", { enum: ["tinker","personal","share","productize"] }).notNull(),
  tag: text("tag", { enum: ["active","background","past"] }).notNull().default("active"),
  workdirPath: text("workdir_path").notNull(),  // absolute
  createdAt: integer("created_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id).notNull(),
  taskId: text("task_id"),  // matches frontmatter ID in .factory/work/<id>.md
  status: text("status", { enum: ["queued","running","completed","failed","aborted"] }).notNull(),
  agentName: text("agent_name").notNull().default("claude-code"),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  tmuxSession: text("tmux_session"),
  sessionId: text("session_id"),  // claude --resume id, if captured
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  exitCode: integer("exit_code"),
  iterationCount: integer("iteration_count").notNull().default(0),
  budgetSeconds: integer("budget_seconds").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").references(() => runs.id).notNull(),
  iteration: integer("iteration").notNull(),
  ts: integer("ts").notNull(),
  kind: text("kind").notNull(),     // see Event Taxonomy
  payload: text("payload", { mode: "json" }).notNull(),
});

export const rubricVersions = sqliteTable("rubric_versions", {
  id: text("id").primaryKey(),                // cuid2
  rubricKey: text("rubric_key").notNull(),    // "rubric-me-tinker"
  version: integer("version").notNull(),
  parentVersionId: text("parent_version_id"),
  yaml: text("yaml").notNull(),               // raw YAML content
  promptKey: text("prompt_key").notNull(),    // references prompts row
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  message: text("message"),                   // commit-message-style
});
// composite unique: (rubricKey, version)

export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  promptKey: text("prompt_key").notNull(),    // "triage-prompt-v1"
  version: integer("version").notNull(),
  content: text("content").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});
```

**Notes**

- `decisions` is the single source of truth for the inbox. Every actionable thing the operator sees is a row here.
- `events` is append-only, indexed on `(run_id, iteration, ts)`. Used to back live tail and post-hoc replay.
- `rubric_versions` and `prompts` are the content-addressed store. Hot-reload reads `WHERE active = 1` per `rubricKey`.
- No foreign-key cascade in v0.1; deletions are soft (status flags) where they happen.

### 5.2 Project Layout (`.factory/`)

Every project has a `.factory/` directory at the repo root. This is committed to the project’s git history.

```
<project-root>/
├── .git/
├── .factory/
│   ├── meta.yaml             # project id, slug, goal, tier, created
│   ├── work/                 # markdown task files (see 5.3)
│   │   ├── task-001-initial-spike.md
│   │   ├── task-002-hello-world.md
│   │   └── ...
│   ├── notes/                # agent-maintained scratchpad (committed)
│   │   └── decisions.md
│   ├── runs/                 # per-run artifact directories (gitignored)
│   │   └── <run-id>/
│   │       ├── log.txt       # raw tmux pane capture
│   │       └── events.jsonl  # structured event stream
│   └── .gitignore            # ignores runs/
├── worktrees/                # gitignored; per-task worktrees
│   └── task-001-abc/
└── (project files...)
```

**Conventions**

- `.factory/meta.yaml` is read on daemon boot to reattach orphaned projects.
- `.factory/notes/` is the agent’s own working memory, persisted in git, queryable on warmup. This is what survives across nights, replacing reliance on session resume.
- `.factory/runs/` is local to the server, gitignored, and rotated by the daemon (keep last N per project).
- `worktrees/` is gitignored; the daemon creates and tears them down per task.

### 5.3 Task Files

Tasks are markdown files with YAML frontmatter, written and read by both the daemon and agents.

```markdown
---
id: task-042
title: Implement basic auth bearer token middleware
status: ready          # ready | in_progress | review | done | blocked | dropped
priority: med          # low | med | high
created: 2026-05-03T14:22:00Z
updated: 2026-05-03T15:01:00Z
parent: epic-001       # optional
labels: [auth, daemon]
estimate: small        # small | medium | large
---

## Context

Daemon currently accepts unauthenticated requests on localhost. We need a
bearer token check before any tRPC request reaches a procedure.

## Acceptance

- [ ] Token loaded from `~/factory/config.yaml`
- [ ] All tRPC procedures gated except `health.ping`
- [ ] PWA sends token in `Authorization: Bearer <token>`
- [ ] 401 on missing or wrong token

## Notes

(free-form, agent-maintained)
```

**Rules**

- ID format: `<kind>-<3-digit-zero-padded>`. Kinds: `task`, `epic`, `bug`, `idea`. Numbers are sequential per project, computed by daemon on creation.
- `status` is the only field the PWA writes directly. Everything else is owned by the agent or by daemon scaffolding.
- Filename = `<id>-<kebab-title>.md`. Title-from-filename is a soft hint; frontmatter is canonical.
- The daemon parses these on demand and indexes a read-cache in SQLite (table not yet specified — defer to implementation; keep cache volatile).

-----

## 6. API

### 6.1 tRPC Routes

Namespaces and core procedures. Inputs/outputs use Zod schemas; types flow to PWA.

```ts
// apps/daemon/src/router.ts (sketch)

export const appRouter = router({
  health: router({
    ping: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  }),

  ideas: router({
    create: protectedProcedure
      .input(z.object({ rawText: z.string().min(1), goalHint: GoalEnum.optional() }))
      .mutation(/* enqueue triage; return idea + decision id */),
    list: protectedProcedure.query(/* recent ideas, with triage status */),
    get: protectedProcedure.input(z.object({ id: z.string() })).query(/* ... */),
  }),

  decisions: router({
    inbox: protectedProcedure.query(/* status=pending, ordered desc */),
    history: protectedProcedure
      .input(z.object({ limit: z.number().default(50) }))
      .query(/* status=actioned|dismissed */),
    action: protectedProcedure
      .input(z.object({
        decisionId: z.string(),
        action: z.enum(["approve","park","trash","decompose","dismiss"]),
        note: z.string().optional(),
      }))
      .mutation(/* dispatch to project bootstrap or update state */),
  }),

  projects: router({
    list: protectedProcedure
      .input(z.object({ tag: z.enum(["active","background","past"]).optional() }))
      .query(/* ... */),
    get: protectedProcedure.input(z.object({ id: z.string() })).query(/* with task list */),
    tag: protectedProcedure
      .input(z.object({ id: z.string(), tag: TagEnum, note: z.string().optional() }))
      .mutation(/* logs a decision row, updates project */),
    tasks: router({
      list: protectedProcedure.input(z.object({ projectId: z.string() })).query(),
      updateStatus: protectedProcedure
        .input(z.object({ projectId: z.string(), taskId: z.string(), status: TaskStatusEnum }))
        .mutation(),
    }),
  }),

  runs: router({
    list: protectedProcedure.input(z.object({ projectId: z.string() })).query(),
    get: protectedProcedure.input(z.object({ id: z.string() })).query(),
    start: protectedProcedure
      .input(z.object({ projectId: z.string(), taskId: z.string().optional(), prompt: z.string().optional() }))
      .mutation(/* enqueue a Run */),
    abort: protectedProcedure.input(z.object({ id: z.string() })).mutation(),
    events: protectedProcedure
      .input(z.object({ runId: z.string(), since: z.number().optional() }))
      .query(/* historical events; live stream is via WS */),
  }),

  rubrics: router({
    list: protectedProcedure.query(/* active rubrics with version metadata */),
    history: protectedProcedure.input(z.object({ key: z.string() })).query(),
    get: protectedProcedure.input(z.object({ key: z.string(), version: z.number().optional() })).query(),
    // edit/activate are v0.2
  }),
});
```

### 6.2 WebSocket Channels

Single WebSocket server, channel by URL path. Auth via bearer query param on initial upgrade (PWA can’t send headers).

|Path                   |Direction    |Purpose                                     |
|-----------------------|-------------|--------------------------------------------|
|`/ws/events?runId=<id>`|server→client|Live structured event stream for a run      |
|`/ws/pane?runId=<id>`  |bidirectional|Tmux pane relay (output + keystrokes)       |
|`/ws/inbox`            |server→client|Push notifications when new decisions arrive|

Pane channel binary frame format: client→server is raw bytes (keystrokes, sent via `tmux send-keys`); server→client is raw bytes from `tmux pipe-pane`. The PWA renders with xterm.js without protocol parsing.

### 6.3 Auth

- Single bearer token, stored on disk at `~/factory/config.yaml` under `auth.token`.
- Generated at install time by `factoryd init`.
- PWA stores in `localStorage` after a one-time entry screen.
- All tRPC requests carry `Authorization: Bearer <token>`.
- WebSocket upgrades carry `?token=<token>` (we’ll switch to subprotocol-based auth in v0.2).
- No user concept. No sessions. Token rotation requires `factoryd rotate-token` and re-pasting in the PWA.

-----

## 7. `@factory/runtime`

The custom agent-runtime layer. Patterns lifted from sandcastle’s analysis; implementation is ours.

### 7.1 Public Interfaces

```ts
// packages/runtime/src/types.ts

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; argSummary: string }
  | { kind: "session"; id: string }
  | { kind: "iteration_start"; iteration: number; ts: number }
  | { kind: "iteration_end"; iteration: number; exitCode: number; ts: number }
  | { kind: "commit"; sha: string; subject: string }
  | { kind: "idle_timeout"; ts: number }
  | { kind: "agent_exit"; exitCode: number; ts: number }
  | { kind: "decision_required"; question: string; options?: string[] };

export interface AgentSpec {
  readonly name: string;                              // "claude-code"
  buildArgv(prompt: string, opts: {
    resumeSessionId?: string;
    model?: string;
  }): {
    argv: readonly string[];
    stdin?: string;
    env?: Record<string, string>;
  };
  parseLine(line: string): readonly StreamEvent[];
  // Detects the "session expired" prompt that Claude shows after ~1h staleness
  detectStaleness?(line: string): boolean;
}

export interface SandboxSpec {
  readonly kind: "host";                              // v0.1: host only
  spawn(opts: SpawnOpts): Promise<SpawnHandle>;
}

export interface SpawnOpts {
  worktreePath: string;
  argv: readonly string[];
  stdin?: string;
  env: Record<string, string>;
  abort: AbortSignal;
  onLine: (line: string) => void;                     // line-streaming, MUST be incremental
  tmux: { sessionName: string; logSocketPath: string };
}

export interface SpawnHandle {
  readonly pid: number;
  readonly tmuxSession: string;
  exit: Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export type BranchStrategy =
  | { type: "head" }                                  // commits land on current branch
  | { type: "branch"; name: string; baseRef?: string }; // explicit named branch
// "merge-to-head" deferred to v0.2

export interface RunSpec {
  runId: string;
  projectPath: string;                                // absolute
  task: { id: string; prompt: string };
  agent: AgentSpec;
  sandbox: SandboxSpec;
  strategy: BranchStrategy;
  budgetSeconds: number;                              // hard wall-clock cap
  maxIterations: number;
  abort: AbortSignal;
  onEvent: (e: StreamEvent & { runId: string; iteration: number }) => void;
  resume?: { sessionId: string };                     // best-effort
}

export interface RunResult {
  runId: string;
  branch: string;
  commits: { sha: string; subject: string }[];
  sessionId?: string;
  exitCode: number;
  iterationsCompleted: number;
}

export interface Runtime {
  spawn(spec: RunSpec): Promise<RunResult>;
  // createSession deferred to v0.2 (multi-iteration persistent sandbox handle)
}
```

### 7.2 Implementation Notes

- `Runtime.spawn` orchestrates: ensure project repo and worktree, render env, build argv, launch via `SandboxSpec.spawn`, tee stdout to `onLine` parser, emit events, capture commits via `git rev-list <baseHead>..HEAD`, clean up.
- Worktree creation: `git worktree add <path> <branch> [--detach]` if the branch doesn’t exist; reuse if it does and is clean.
- The host sandbox spawns the agent inside a tmux session: `tmux new-session -d -s <name> -c <worktreePath> '<agent argv>'`. `pipe-pane -o "cat >> <socketPath>"` provides line-buffered output. The daemon tails the socket.
- The agent CLI (`claude`) inherits the daemon’s environment, including subscription credentials in `~/.claude/`. No `ANTHROPIC_API_KEY`, no OAuth token gymnastics.
- After the run, the worktree is preserved if dirty (operator inspection) or removed if clean (default). Configurable per run.
- Budget enforcement: a `setTimeout` triggers `abort.abort()` at `budgetSeconds`. The agent gets a clean termination signal; partial commits are preserved.

### 7.3 Claude Staleness Handling

The Claude CLI prompts for re-auth or re-resume after ~1h since last activity. Our defense is layered:

1. **Worktree-as-truth (primary).** Each iteration is a fresh `claude --print -p -` invocation. The prompt carries enough context to reconstitute (recent task notes, recent commits, current task acceptance criteria). We do NOT pass `--resume` by default.
1. **Iteration ceiling on wall-clock.** If we *do* opt into resume for tight loops, no iteration runs longer than 50 minutes.
1. **Staleness detection.** `AgentSpec.detectStaleness(line)` watches for known prompt strings (“Resume conversation? (y/N)”, session-expired patterns). If matched within the first N seconds of a fresh invocation, the runtime kills the child, does NOT pass `--resume`, and re-invokes with a fresh prompt that includes a “you were previously working on…” reconstitution stub built from the worktree’s recent state.
1. **Reconstitution prompt template.** Lives in the prompts table, version-controlled. Renders the last 10 commits, the current task frontmatter, and the last 100 lines of `.factory/notes/decisions.md`.

This is the architectural commitment that makes overnight runs durable without depending on Claude’s session machinery.

### 7.4 Concurrency

- Worker pool default `maxConcurrentRuns = 4` for v0.1. Configurable.
- Each run owns its own `AbortController` and tmux session. No global locks.
- Concurrent runs against the same project use distinct worktree paths and distinct branch names. The runtime asserts uniqueness.

-----

## 8. PWA

### 8.1 Screen Inventory

Routes and their primary purpose. Mobile-first; desktop is a wider variant of the same layout.

|Route                      |Screen                            |Primary action                  |
|---------------------------|----------------------------------|--------------------------------|
|`/`                        |**Decisions Inbox** (home)        |Tap to action a pending decision|
|`/inbox/new`               |Idea capture                      |Submit text + optional goal hint|
|`/projects`                |Projects list, tag-filtered       |Tap to drill in                 |
|`/projects/:id`            |Project detail (tasks, runs, tags)|Start run; tag project          |
|`/projects/:id/runs/:runId`|Live pane (xterm.js)              |Watch / kill / annotate         |
|`/history`                 |Decision history                  |Browse past decisions           |
|`/settings`                |Token, server info, log level     |Rotate token                    |

**The home screen is the inbox.** Every other screen is one tap away from it. Push notifications (later) and badge counts (v0.1) drive the operator back here.

### 8.2 Inbox Card Anatomy

Each pending decision renders as a card with:

- A type chip (Triage, Tag Change, etc.).
- A short title (idea text excerpt or project name).
- The agent’s verdict and confidence (e.g. “Greenlit · score 7.8 · low uncertainty”).
- A two-line rationale snippet.
- Primary action buttons: **Approve**, **Park**, **Trash**, **Decompose** (or for tag changes: **Confirm**, **Override**).
- A long-press menu for: see full rationale, see rubric version used, dismiss.

Cards stack densely. Swipe-left to dismiss; swipe-right to approve (default action). Tapping the card body opens a full-screen detail sheet with the complete agent output.

### 8.3 Live Pane

- xterm.js bound to `/ws/pane?runId=<id>`.
- Header: project name, task title, run status, elapsed, iteration count, kill button.
- Footer: structured event ticker (last 10 events from `/ws/events`), with click-to-jump-in-pane behavior.
- Mobile-aware: pane is full-bleed; soft keyboard does not cover the input area; double-tap toggles fullscreen.

### 8.4 Component Conventions

- All interactive components built on Radix primitives via shadcn/ui’s generator. Components live in `apps/pwa/src/components/ui/` and are owned, not consumed from a registry.
- Tailwind v4 with a custom theme in `apps/pwa/src/styles/theme.css`. Dark mode default; light mode opt-in via `data-theme`.
- Dense by design: list rows ~48px tall on mobile, no whitespace padding.
- Skeleton loaders, never spinners, on initial loads.
- Optimistic updates on tag changes and decision actions; reconcile on tRPC response.
- Use the **frontend-design skill** at implementation time. The PWA must look custom and considered — not “shadcn default.”

-----

## 9. Triage System

### 9.1 Rubric Storage

- Rubrics live in `rubric_versions` rows. Each has a `yaml` blob and a `prompt_key` reference to a prompt version.
- The daemon ships seed YAMLs in `rubrics/`. On first boot (or on `factoryd seed`), seeds are imported as version 1 and marked active.
- For v0.1, edits happen by replacing the seed file and running `factoryd rubric import`. New version row inserted, old version deactivated. Hot reload picks it up on next triage call (no daemon restart).

### 9.2 The v0.1 Rubric — `rubric-me-tinker.yaml`

```yaml
id: rubric-me-tinker
version: 1
goal: me
tier: tinker
description: |
  Triage rubric for personal-use ideas at tinker tier. Optimizes for
  "is this worth a few hours" not "is this worth a quarter." Personal
  fit weighted heavily; market and competitive axes intentionally absent.

axes:
  - id: utility
    weight: 0.25
    prompt: |
      Does this solve a real problem the user has, or is it a
      "would be cool if..." idea? Score 0-10. Score 0 if purely
      speculative. Score 10 if user has an active workaround they
      hate. Cite the user's own framing if available.

  - id: feasibility
    weight: 0.20
    prompt: |
      Can a competent agent build a working tinker-tier prototype in
      a single overnight run (~6-8 hours)? Score 0-10. Penalize for:
      requires ML training, requires hardware, requires services
      with no free tier, requires data the user doesn't have.
      Reward for: standard web/CLI/library shape, well-trodden stack.

  - id: personal_fit
    weight: 0.25
    prompt: |
      Would the user actually want to live with this for the next
      2-4 weeks of iteration? Score 0-10. Penalize ideas that are
      "interesting in theory" but the user has shown no sustained
      interest in. Reward ideas that connect to themes the user
      returns to (infra tooling, dev utilities, knowledge systems,
      CLI ergonomics, agent workflows).

  - id: time_to_first_value
    weight: 0.15
    prompt: |
      How fast until the user gets something usable, even if rough?
      Score 0-10. 10 = working demo within first run. 5 = useful
      after a few iterations. 0 = requires significant scaffolding
      before any value emerges.

  - id: stack_fit
    weight: 0.15
    prompt: |
      Does this leverage the user's strengths (TS/Bun/Node, infra,
      networking, K8s, agent tooling) or force a stretch into
      unfamiliar territory? Score 0-10. 10 = right in the wheelhouse.
      5 = adjacent stretch. 0 = entirely new domain. Note: a stretch
      isn't disqualifying for tinker tier, just a friction signal.

outcomes:
  greenlit:
    when: weighted_score >= 7.0 AND uncertainty <= 0.3
    produces:
      tier: tinker
      spec_stub: required
      initial_tasks: 3-5

  decompose:
    when: uncertainty > 0.4
    produces:
      clarifying_questions: 1-3
      return_to: inbox

  parked:
    when: weighted_score >= 5.0 AND weighted_score < 7.0
    produces:
      marinate_until_days: 14
      rationale: required

  trashed:
    when: weighted_score < 5.0
    produces:
      rationale: required
      what_would_change_verdict: required

uncertainty_sources:
  - missing_axis_evidence
  - conflicting_signals
  - insufficient_idea_detail

agent_invocation:
  agent_provider: claude-code
  iterations: 1
  max_wall_seconds: 120
  prompt_key: triage-prompt-v1
```

### 9.3 Triage Prompt Template (`triage-prompt-v1`)

The prompt the agent sees. Renders with the rubric, the idea text, and any operator-supplied context. Lives in the `prompts` table; checked into `prompts/triage-prompt-v1.md` for seed.

The prompt instructs the agent to:

1. Read the idea and any goal hint.
1. Score every axis 0-10 with a one-sentence rationale citing evidence (idea text, user history if provided, web search if needed).
1. Compute weighted score and self-rated uncertainty (0-1).
1. Apply outcome rules and emit a structured JSON result matching the decision schema.
1. If `decompose`, list 1-3 clarifying questions. If `trashed`, fill `what_would_change_verdict`.

The agent’s response is parsed into a `decisions` row with `kind="triage"`, `payload` carrying the full structured output.

### 9.4 Decision Outcomes

- **Greenlit** → operator approves → daemon runs project bootstrap (§10).
- **Parked** → operator can manually promote later; resurfacing scheduler is v0.2.
- **Trashed** → recorded with rationale; searchable; one-tap “re-triage” available.
- **Decompose** → questions returned to operator; answered text re-enters the triage queue with original idea + answers.

Operator override on any outcome is one tap; the override is logged with optional reason for future rubric calibration (post-v0.1).

-----

## 10. Project Bootstrap

End-to-end flow when the operator approves a Greenlit decision.

1. Daemon allocates a `projectId` and `slug` (kebab-cased title; uniqueness checked).
1. Creates `~/factory/projects/<slug>/`, runs `git init`, sets local `user.name` / `user.email` from daemon config.
1. Writes `.factory/meta.yaml`, `.factory/notes/decisions.md` (initial: “Project created from idea X”), `.gitignore` with `worktrees/` and `.factory/runs/`.
1. Generates 3-5 initial task files in `.factory/work/` from the agent’s `spec_stub`. Each file carries frontmatter and a populated body.
1. Initial commit: `chore: factory bootstrap`.
1. Inserts a `projects` row, tag = `active`.
1. Closes the originating decision (`status: actioned`).
1. Optionally enqueues the first run automatically (configurable; default OFF for v0.1 — operator taps Start Run).

Project bootstrap is a single atomic-ish operation. If any step fails, the whole project directory is rolled back and the decision returns to `pending` with a failure note.

-----

## 11. Operating Contract

What v0.1 promises and what it doesn’t.

**Promises**

- A submitted idea will be triaged within 2 minutes or surface a failure card.
- A greenlit idea, once approved, becomes a real project on disk within 30 seconds.
- A running agent’s output is observable live from anywhere with PWA access.
- Tagging a project never blocks; it’s a single tRPC mutation with no agent involvement.
- Daemon restart preserves all state. In-flight runs are aborted cleanly; their last iteration’s commits are preserved.
- The operator’s only “must-respond” surface is the decisions inbox.

**Doesn’t promise**

- That an agent’s output is correct. v0.1 has no verification layer beyond what the agent does itself; CI and scenarios come later.
- That parked ideas resurface. The marinate scheduler is v0.2.
- That rubrics auto-improve. Self-iteration is v0.2+.
- That multi-agent or multi-project coordination is sane. Run one thing at a time per project.
- That the factory survives `rm -rf`. State is on disk; back up `~/factory/data.db` and `~/factory/projects/`.

**Failure surfacing**

Every failure surfaces as a decision card with `kind="triage"` (failed triage), or as a run with `status="failed"` visible in project detail. Nothing fails silently.

-----

## 12. Repo Layout

```
factory/
├── apps/
│   ├── daemon/
│   │   ├── src/
│   │   │   ├── index.ts          # entry, signal handling, supervised lifecycle
│   │   │   ├── router.ts         # tRPC root router
│   │   │   ├── ws/               # WebSocket hub
│   │   │   ├── workers/          # worker pool, run executor
│   │   │   ├── triage/           # triage orchestration
│   │   │   ├── projects/         # bootstrap, task file IO
│   │   │   ├── tmux/             # session manager, pipe-pane reader
│   │   │   └── auth.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── pwa/
│       ├── src/
│       │   ├── routes/
│       │   ├── components/
│       │   │   └── ui/           # shadcn-generated, owned
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── styles/
│       ├── index.html
│       ├── vite.config.ts
│       ├── package.json
│       └── tailwind.config.ts
├── packages/
│   ├── runtime/                  # @factory/runtime
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── runtime.ts        # spawn() impl
│   │   │   ├── agents/
│   │   │   │   └── claude-code.ts
│   │   │   ├── sandboxes/
│   │   │   │   └── host.ts
│   │   │   ├── tmux.ts
│   │   │   └── worktree.ts
│   │   └── package.json
│   ├── db/                       # @factory/db
│   │   ├── src/
│   │   │   ├── schema.ts
│   │   │   ├── client.ts
│   │   │   └── migrations/       # generated by drizzle-kit
│   │   └── package.json
│   └── shared/                   # @factory/shared
│       ├── src/
│       │   ├── types.ts          # cross-package types
│       │   └── enums.ts
│       └── package.json
├── rubrics/
│   └── rubric-me-tinker.yaml
├── prompts/
│   ├── triage-prompt-v1.md
│   └── reconstitution-prompt-v1.md
├── docs/
│   ├── spec.md                   # this document
│   ├── handoff.md                # Claude Code handoff
│   └── adr/                      # architecture decision records, ongoing
├── scripts/
│   ├── factoryd-init.ts          # config bootstrap
│   └── seed.ts                   # rubric/prompt import
├── .editorconfig
├── .gitignore
├── biome.json                    # formatter + linter
├── package.json                  # workspaces root
├── tsconfig.base.json
├── bun.lockb
└── README.md
```

Bun workspaces. Single lockfile. Biome over ESLint+Prettier for speed and one-config simplicity.

-----

## 13. Post-v0.1 Backlog

Tracked here so v0.1 doesn’t lose them.

### v0.2 — Multi-agent, multi-tier, IDE

- Codex and Gemini CLI agent providers.
- Quality tiers beyond `tinker`: `personal`, with verification gating.
- Goals beyond `me`: `learn`, with stack-stretch logic.
- In-factory rubric/prompt IDE (Monaco editor, version history, diff view, “test against this idea” runner).
- Rubric edits via PWA, hot-reload, full version history surfaced.
- Marinate scheduler — parked ideas resurface on schedule.
- Multi-iteration `createSession` runtime API for tight resume loops.
- Tmux staleness detect-and-restart safety net (today: worktree-as-truth only).

### v0.3 — Verification & promotion

- Backpressure layer: lint/type/test as automatic feedback, not surfaced unless they fail.
- Scenario harness — small end-to-end test corpus per project, runs after every run.
- Promotion gates — explicit checkpoints (first PR, day-7, first user) where the daemon pauses and surfaces a promotion decision.
- Tier promotion (`tinker → personal → share`) requires verification re-run at the new bar.

### v0.4 — Compounding

- Package shelf — polyglot cross-project library of opinionated wrappers (auth, db, billing, UI primitives, observability, feature flags).
- Foundry stage — separate spec-generation step between triage and bootstrap, with explicit clarification loop.
- Real-world pain axis — agent scrapes forums/reviews/Reddit for evidence supporting `share`/`productize` tier triage.
- Service on-ramp — Stripe sandbox, Neon, Vercel, etc., each with provision + local-fallback + cleanup.

### v0.5+ — Self-iteration & scale

- Rubric self-iteration — outcome correlation tracking, override pattern detection, factory-proposed rubric versions for human approval.
- Goal-and-tier-dependent rubric routing — different rubrics for different goal/tier combos, swappable.
- Cross-project orchestrator memory — bounded “what the factory has learned” journal.
- Multi-project parallel runs from a single operator queue.
- Container sandboxes (Docker provider) for untrusted runs.
- Container-isolated provider for “burn-and-resurrect” experiments.
- Multi-machine fleet — daemon-to-daemon protocol; OpenClaw integration optional.
- Auth hardening — multi-token, scoped tokens, audit log.
- Mobile push notifications.

### Cross-cutting wishlist (no version assigned)

- Voice-to-idea capture pipeline.
- Email-to-inbox.
- Weekly factory digest (what shipped, what stalled, what got trashed).
- Trash-with-analysis search and “what would change verdict” recovery flow.
- Optional Engram memory backend — only after Engram earns it.
- Optional ACP agent provider — only if a strong reason emerges (structured tool-call cards in PWA).

-----

## 14. Open Questions (acceptable for v0.1 but worth flagging)

1. **Tmux output capture rate.** `pipe-pane` to a file/socket scales fine for single-digit concurrent runs but worth checking under load. If it bottlenecks, options: per-run named pipe, or shell out to `tmux capture-pane` on poll.
1. **Worktree disk usage.** `git worktree` is cheap but not free; per-task worktrees on a server with limited disk could stack up. Mitigation: aggressive cleanup post-run; surface disk usage in settings.
1. **Bearer token in WS query string.** Logged in some access logs. Acceptable for v0.1 single-user; v0.2 should move to subprotocol or first-message auth.
1. **Rubric YAML in a single column.** Simple, but loses queryability (e.g. “find all rubrics with a `personal_fit` axis”). Acceptable for v0.1; revisit if cross-rubric introspection becomes useful.
1. **Idea capture from outside the PWA.** Out of scope for v0.1; the PWA is the only ingestion. If the inbox empties because capture is too friction-y, this gets prioritized. Most likely answer is a Telegram bot or an email-to-inbox.

-----

## 15. What “done” looks like for v0.1

A single demo, recorded on a phone:

1. Operator types an idea into the PWA from the couch.
1. ~30 seconds later, a decision card appears in the inbox with a Greenlit verdict.
1. Operator taps Approve.
1. Operator opens the project, sees 4 task files, taps Start Run on task-001.
1. The live pane shows Claude Code working in the worktree.
1. Operator locks the phone, comes back 20 minutes later, sees the run completed with 3 commits.
1. Operator tags the project `active`, writes a one-liner note, closes the app.

If that runs end-to-end without hand-holding, v0.1 is done.
