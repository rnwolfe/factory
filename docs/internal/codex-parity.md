# Codex parity inventory (task-017)

Every site in the codebase that today drives a Claude CLI invocation, with
its prompt shape, output contract, and a written codex-parity acceptance
test. Status is one of:

- **`parity-verified`** — agent kind is dispatched at this site AND a
  parity test exists that asserts codex produces the equivalent
  downstream effect.
- **`parity-blocked`** — gating reason recorded inline + named follow-up
  plan that will resolve it.

No site is allowed to stay indeterminate.

**Today's overall status (post task-019 wiring):**

- Every non-resume Claude-bound site now dispatches on agent kind through
  the shared `invokeClaudeJson` (`apps/daemon/src/plans/invoke-claude.ts`)
  and a centralized resolver (`apps/daemon/src/agents/resolve.ts`). The
  inheritance chain is
  `explicit override → task.frontmatter.agent → settings.default-agent → "claude-code"`.
  Per-project agent selection (`projects.agent_name` column) remains on the
  task-020 follow-up; until then, operators flip the system-wide default via
  the new `default-agent` setting.
- Resume-dependent sites (audit comment reply 4d, feedback follow-up 5a,
  plan iterate follow-up turn in 3b) stay `parity-blocked` for the
  resume path specifically: under `agent=codex` those sites suppress the
  resume branch and either rebuild the full prompt (plan iterate, feedback)
  or surface an in-thread "switch agent" hint (audit comments — its short
  prompt assumes prior thread is in context and has no full-prompt
  alternative). The fresh-turn path on each of those sites is verified.
- `runs` submission (`workers/submit.ts`) refuses with an actionable
  error when `agent=codex` + `resume=true` (or `reuseFromRunId` of a row
  that captured a sessionId). Operators see the error verbatim in the PWA
  toast and can switch agent / pick a different run path.

Sites whose Claude path uses `claude --resume <sessionId>` therefore carry
the documented gating reason (`codex exec` has no equivalent, ADR-006);
the resume gap is the only remaining `parity-blocked` axis after task-019.

The codex agent's own contract (text events, session id capture, fenced
JSON in `agent_message`, model flag) is established in
`packages/runtime/src/agents/codex.ts:37` and exercised in the run path
via `runtime.spawn`. The parity tests below treat that contract as
ground-truth — sites are tested by swapping the agent kind, not by
re-validating the codex provider.

---

## 0 — Runtime provider layer

### 0a · Claude agent provider

- **Site:** `packages/runtime/src/agents/claude-code.ts:148`
  (`claudeCodeAgent: AgentSpec`)
- **What it produces:** the `argv` that spawns
  `claude --print --output-format stream-json --verbose
  --dangerously-skip-permissions [--resume <id>] [--model <m>]` with the
  prompt on stdin, plus a `parseLine` that turns stream-json into
  `StreamEvent` instances (`text`, `tool`, `session`, `metrics`,
  `usage_limit`, `agent_exit`).
- **Output contract this provider expects from the CLI:** newline-delimited
  stream-json. Type=`system` carries `session_id`. Type=`assistant`
  carries text + tool_use blocks. Type=`result` carries final cost,
  per-model usage, and `is_error`+ `result` for usage-limit detection.
- **Codex-parity equivalent:** `packages/runtime/src/agents/codex.ts:37`
  (`codexAgent: AgentSpec`). Same interface; argv builds `codex exec
  --json --dangerously-bypass-approvals-and-sandbox [--model <m>]`;
  `parseLine` handles `thread.started` / `item.completed` /
  `turn.completed` events.
- **Parity test:** given the same prompt string, both providers' `argv`
  arrays start their respective binary, take stdin, and emit at least one
  `text` event + one `metrics` event + one `agent_exit` event when the
  underlying CLI is replayed from a recorded fixture. Test would live at
  `packages/runtime/tests/agent-parity.test.ts`.
- **Status:** `parity-blocked` — fixture-replay test does not exist.
  Follow-up: **task-019**.

### 0b · Codex agent provider

- **Site:** `packages/runtime/src/agents/codex.ts:37`
- **Subscription auth, `--model` support, `agent_message` text events,
  `thread.started` session ids:** all confirmed in
  [`docs/adr/006-codex-harness.md`](../adr/006-codex-harness.md).
- **Known gaps vs claude-code provider (load-bearing for downstream sites):**
  1. No `--resume` equivalent — `opts.resumeSessionId` is intentionally
     ignored (`codex.ts:54`). Any site that resumes a session must fall
     back to a fresh full-prompt invocation when agent=codex.
  2. No per-call cost — `totalCostUsd` always 0 (`codex.ts:107`).
  3. `usage_limit` detection is heuristic (`USAGE_LIMIT_RE` on
     `agent_message` text); claude's is structured.
- **Status:** `parity-blocked` for the *provider being wired into callers*.
  The provider itself is implemented; what's missing is every call site
  selecting it. Follow-up: **task-019** (wiring) and **task-020** (picker).

---

## 1 — `runtime.spawn` callers (code-changing runs)

### 1a · `runner.ts`: code-changing run executor

- **Site:** `apps/daemon/src/workers/runner.ts:286` —
  `agent: claudeCodeAgent` is hardcoded inside the `runtime.spawn` call.
- **Prompt shape:** the task body wrapped by
  `wrapPrompt`/`wrapPromptWithPlan`/`wrapResumePrompt[WithPlan]`
  (`apps/daemon/src/workers/factory-status.ts`) — appends the
  factory-status, factory-decision, and factory-defer protocol footers,
  optionally prepends `## Operator notes` from
  `prependOperatorContext`, and optionally injects a frozen
  `task_plan` draft as authoritative context.
- **Output contract parsed:**
  1. **`factory-status` fenced block** — `parseFactoryStatus` extracts
     a JSON object carrying `status` ∈ {`done`,`blocked`,`failed`},
     `summary`, `questions`, optional `acceptance[]`. Null parse → run
     marked `failed`. (`apps/daemon/src/workers/factory-status.ts`)
  2. **`factory-defer` fenced block** — `parseFactoryDefer` extracts
     `{command, summary, continuation}`. When present, takes
     precedence over factory-status; routed to
     `spawnDeferredTask`.
  3. **`factory-decision` fenced blocks (streaming)** —
     `persistAgentDecisions` extracts zero-or-more decision objects;
     surfaced to the inbox.
  4. **`usage_limit` StreamEvent** — emitted by the provider's
     `parseLine`; gates the `usage_capped` run status and auto-resume.
  5. **`metrics` StreamEvent** — written to `claude_metrics` row.
  6. **`session` StreamEvent** — written to `runs.sessionId` and to
     `runs.session_id` for resume.
- **Critical secondary effect:** auto-commit residual dirty state, then
  auto-merge to main via `mergeIntoMain` on `completed`.
- **Codex-parity acceptance test:** with `agent=codex` set on the
  project/run, executing a task whose body is "create `hello.txt` with
  the word 'hi' and emit `factory-status` done" produces (a) a merge
  commit on main containing `hello.txt`, (b) a `runs` row with
  `status='completed'`, `agentName='codex'`, `sessionId` non-null,
  (c) at least one `claude_metrics` row attributed to the run, (d) a
  task-status update to `done` propagated to main. Same fixture under
  `agent=claude-code` produces the same shape (modulo `totalCostUsd`
  which is always 0 for codex).
- **Status:** `parity-verified` (post task-019). The runner already
  dispatched on `row.agentName` via `agentForRow` (`runner.ts:139`); the
  remaining wiring was at the run-row insertion in 1b. Resume-dependent
  retry / intervene paths are now refused at submit time when
  `agent=codex` (see 1b).

### 1b · `submit.ts`: run row creation

- **Site:** `apps/daemon/src/workers/submit.ts:213` —
  `agentName: "claude-code"` hardcoded when inserting a new `runs`
  row. The schema column already supports arbitrary values (default
  `claude-code`, no enum constraint —
  `packages/db/src/schema.ts:330`).
- **Codex-parity acceptance test:** submitting a run on a project whose
  effective agent is `codex` writes `agentName='codex'` to the new
  row, and the row's downstream execution (1a above) honors that
  selection.
- **Status:** `parity-verified` (post task-019). `effectiveAgent` is now
  resolved at submit time from
  `input.agent → task.frontmatter.agent → settings.default-agent → "claude-code"`
  and persisted on the run row's `agentName`. (Per-project
  `projects.agent_name` is still pending task-020; the settings-level
  default covers operator-wide preference until then.)
  Resume-dependent run paths (intervene-resume, reuseFromRunId of a
  session-carrying source) are refused at submit time under `agent=codex`
  with an actionable error linking back to this document.

### 1c · `runtime.ts`: the `runtime.spawn` entry point itself

- **Site:** `packages/runtime/src/runtime.ts:81` — `spec.agent.buildArgv(...)`,
  `spec.agent.parseLine(...)`, `spec.agent.detectStaleness?.(...)`.
- **Agent dependence:** none. The runtime treats `spec.agent` as an
  opaque `AgentSpec` and never reaches into provider internals. Any
  AgentSpec that emits the documented `StreamEvent` kinds works.
- **Status:** `parity-verified` (interface-level) — the runtime is
  already agent-agnostic. No code change required for codex; only
  callers need to pass `agent: codexAgent`.

---

## 2 — Triage (idea → decision)

### 2a · `runTriage`: initial triage of an idea

- **Site:** `apps/daemon/src/triage/orchestrate.ts:239`. The CLI spawn is
  inlined as a local `invokeClaudeJson` at `triage/orchestrate.ts:103`,
  which calls `claudeCodeAgent.buildArgv` directly (`:108`) and runs
  events through `claudeCodeAgent.parseLine` (`:146`,`:151`).
- **Prompt shape:** rendered template from `prompts` table (key from
  `selectRubricKey` × ceremony/role). Variables: `{{IDEA_TEXT}}`,
  `{{INTENT_CEREMONY}}`, `{{INTENT_ROLE}}`, `{{RUBRIC_YAML}}`.
- **Output contract parsed:** **fenced JSON envelope** (any
  ```` ```json ```` block or first balanced top-level `{…}`) shaped
  as `TriageDecisionPayload` (`triage/orchestrate.ts:47-74`): outcome,
  weighted_score, axes[], rationale, spec_stub, decompose_questions,
  …. `findBalancedJsonObject` handles prose-wrapping;
  `extractJson` raises on parse failure.
- **Secondary effects:** writes a `decisions` row, marks idea
  `triagedAt`, records claude metrics under `ownerKind='triage'`.
- **Codex-parity acceptance test:** triage of the fixture idea "build a
  CLI that prints today's weather" under `agent=codex` writes a
  `decisions` row whose `payload.outcome` is one of the four legal
  values and whose `payload.axes` has one entry per rubric axis
  (proves the codex agent_message text carried a parseable envelope).
  Same idea under `agent=claude-code` is the baseline.
- **Status:** `parity-verified` (post task-019). The local
  `invokeClaudeJson` is now a thin wrapper (`invokeTriageAgent`) around
  the shared dispatcher and resolves agent from `settings.default-agent`
  via `resolveAgent(db)`. Same dispatch path as plans/audits/feedback.

### 2b · `runFollowupTriage`: re-triage after operator comment

- **Site:** `apps/daemon/src/triage/orchestrate.ts:348`. Uses the same
  local `invokeClaudeJson` at `:433`.
- **Prompt shape:** template `triage-followup-v1` with
  `{{PRIOR_DECISION_JSON}}` and `{{THREAD}}` added.
- **Output contract parsed:** same `TriageDecisionPayload` plus an
  optional `reply` string (used as the agent's thread comment).
- **Resume behavior:** does NOT use `--resume`. Each follow-up turn
  re-renders the full thread into the prompt. So codex's lack of
  `--resume` is not a parity blocker here.
- **Codex-parity acceptance test:** posting an operator comment "are
  you sure about axis X?" on a fixture decision under `agent=codex`
  produces (a) an updated `decisions.payload` carrying a valid
  outcome, (b) a new `decision_comments` row with role='agent' and a
  non-empty body, (c) `verdictChanged` boolean correctly computed.
- **Status:** `parity-verified` (post task-019). Routes through the same
  agent dispatcher as 2a.

---

## 3 — Plan iteration

### 3a · The shared dispatcher: `invokeClaudeJson`

- **Site:** `apps/daemon/src/plans/invoke-claude.ts:49`. Calls
  `claudeCodeAgent.buildArgv` (`:58`) and `claudeCodeAgent.parseLine`
  (`:98`,`:103`). Returns `{text, sessionId, metrics}` for callers
  that need to thread session continuity.
- **Why this matters:** this one function is the agent boundary for
  every non-runtime.spawn agent call in the daemon (plans, audits,
  audit promote, audit comments, feedback iterate, spec import).
  Making *this* dispatch on agent kind resolves parity for every
  caller listed below in one place.
- **Resume sensitivity:** accepts `resumeSessionId` and passes it
  through to `buildArgv`, which becomes `claude --resume <id>`. Codex
  has no equivalent. Callers that pass `resumeSessionId` under
  `agent=codex` must either (a) silently ignore the resume and
  re-prompt with the full thread, or (b) be flagged `parity-blocked`
  on the resume path specifically.
- **Codex-parity acceptance test:** a unit test that swaps
  `claudeCodeAgent` for `codexAgent`, runs `invokeClaudeJson` against
  a recorded codex JSON-event stream, and asserts the returned
  `{text, sessionId, metrics}` shape matches the claude case for the
  same prompt. Lives at `apps/daemon/src/plans/invoke-claude.test.ts`.
- **Status:** `parity-verified` (post task-019). Function now dispatches
  by `opts.agent ∈ {"claude-code","codex"}` (default `"claude-code"`).
  Resume requested against an agent that doesn't support resume throws
  `ResumeUnsupportedError`; callers either suppress the resume branch
  (plans, feedback) or surface an in-thread error (audit comments).
  `agentByName`, `SUPPORTED_AGENT_NAMES`, `agentSupportsResume`, and
  `ResumeUnsupportedError` are exported for use by callers.

### 3b · `runPlanIteration` — all five plan kinds

- **Site:** `apps/daemon/src/plans/iterate.ts:495`. Five kinds dispatched
  by `plan.kind`:
  - `project_spec` (`:338`) — context: idea + triage payload.
  - `task_plan` (`:359`) — context: project README + CLAUDE.md +
    task body.
  - `refinement` (`:383`) — context: task body + source run
    summary/commits.
  - `feature_plan` (`:417`) — context: README + CLAUDE.md + VISION.md
    + feature goal.
  - `project_vision` (`:442`) — context: README + CLAUDE.md +
    existing VISION + recent git log.
- **Prompt shape:** rendered template (`prompts` table, key per
  `planPromptKey(kind)`) with kind-specific variables. On resume, a
  short follow-up template (`renderFollowUpPrompt`,
  `iterate.ts:95`) replaces the full template — explicitly relies on
  `claude --resume` carrying prior context.
- **Output contract parsed:** **plain JSON object** extracted by
  `extractJsonObject` (`apps/daemon/src/plans/json-extract.ts`).
  Shape per `plan.kind` — `coerceDraft` (`iterate.ts:149`) validates
  field-by-field. Reply prose lives in the JSON's `reply` field, NOT
  outside the envelope.
- **Secondary effects:** persists `plan_comments` row, updates
  `plans.draft`, stamps `plans.claudeSessionId` + `plans.promptVersion`
  on success so the next turn can resume.
- **Codex-parity acceptance test:** for each kind, iterating a plan
  under `agent=codex` produces (a) a new `plan_comments` row with
  `resultingDraft` non-null, (b) `plans.draft` updated, (c) the
  parsed draft passes `coerceDraft` for that kind, (d) every field
  the claude baseline populated is also populated by codex (allows
  string content to differ; structure must match). Fixture: same
  prompt template, same project context, same operator message.
- **Status (fresh-turn):** `parity-verified` (post task-019). When no
  prior session is captured (or when agent doesn't support resume),
  iteration sends the full prompt — context preserved.
- **Status (resume turn):** `parity-blocked` for agents that don't support
  resume (`codex` today). Behavior: under `agent=codex`, `canResume` is
  forced false; the iteration falls through to the full-prompt branch
  unconditionally. Correctness preserved at extra token cost.
- Follow-up: when codex (or a successor) gains a session-resume mechanic,
  add it to `agentSupportsResume` and the `canResume` gate re-enables.

### 3c · Plan-freeze application modules (no claude invocation)

- **Sites:**
  - `apps/daemon/src/plans/refine.ts`
  - `apps/daemon/src/plans/bootstrap-from-plan.ts`
  - `apps/daemon/src/plans/apply-feature-plan.ts`
  - `apps/daemon/src/plans/apply-project-vision.ts`
- **Agent dependence:** **none.** These modules write files, create
  task markdown, and commit on the project's main branch. Verified by
  `grep -nE 'invokeClaudeJson|claudeCodeAgent|spawn|claude' …` —
  matches in `apply-project-vision.ts` are filename references
  (`CLAUDE.md`), not invocations.
- **Status:** `parity-verified` — no agent code present, no parity
  consideration required. Listed in the acceptance criterion's
  enumeration; documented here for completeness so a future reader
  doesn't conclude they were skipped.

---

## 4 — Audits

### 4a · `runAuditIteration` (read-only audits)

- **Site:** `apps/daemon/src/audits/iterate.ts:42`. Uses the shared
  `invokeClaudeJson` (`:84`).
- **Prompt shape:** built by `buildAuditPrompt`
  (`audits/prompts.ts`) — interpolates the project's
  `<workdirPath>/.factory/audits/<name>/SKILL.md` body with project
  context (vision excerpt, CLAUDE.md excerpt, recent commits, prior
  audits).
- **Output contract parsed:** `parseAuditResponse`
  (`audits/findings.ts`) — looks for a fenced JSON envelope with
  `report` (markdown string) and `findings[]` (severity, title, body,
  filePath, line). Null parse → audit marked `status='failed'`.
- **Secondary effects:** writes `audits.reportMarkdown`,
  `audits.findings`, `audits.claudeSessionId`; records metrics with
  `ownerKind='audit'`.
- **Codex-parity acceptance test:** running a read-only audit (skill
  fixture `audit-test-skill`) against a project under `agent=codex`
  produces (a) `audits.status='completed'`, (b) `reportMarkdown`
  non-empty, (c) at least one finding row, (d) the same set of
  finding severities as the claude baseline on the same fixture
  (string content may differ; severity distribution must match).
- **Status:** `parity-verified` (post task-019). Audit iteration calls
  `invokeClaudeJson` with `agent: resolveAgent(db)`. Read-only audits do
  not use resume, so codex parity has no remaining axis here.

### 4b · `runExecAudit` (exec audits with cwd=worktree)

- **Site:** `apps/daemon/src/audits/exec-iterate.ts:34`. Uses the
  shared `invokeClaudeJson` with `cwd: wt.worktreePath` (`:86`) so the
  agent's shell tools see the project's tracked files.
- **Prompt shape & output contract:** identical to 4a (same
  `buildAuditPrompt` + `parseAuditResponse`).
- **Critical secondary effect:** creates a per-audit worktree
  (`factory/audit-<auditId>`) for the duration of the call, tears it
  down on completion or failure.
- **Codex-parity acceptance test:** same as 4a, but with an exec-kind
  skill that runs at least one Bash tool call. Asserts (a) the
  worktree was created and removed, (b) the report contains
  evidence the agent read files from the worktree (e.g., a finding
  cites a real file path that exists on disk).
- **Status:** `parity-verified` (post task-019). Exec audits now pass
  `agent: resolveAgent(db)` to `invokeClaudeJson` alongside `cwd`. Codex's
  shell tool calls are confirmed working per ADR-006.

### 4c · `bridgePromoteFindings` (promote findings → plan or bug)

- **Site:** `apps/daemon/src/audits/promote.ts:52`. Uses shared
  `invokeClaudeJson` (`:85`).
- **Prompt shape:** rendered `audit-bridge-v1` template with
  `{{FINDINGS_MARKDOWN}}` + project context + vision excerpt.
- **Output contract parsed:** fenced JSON shaped as
  `PromoteRecommendation` — discriminated union on `recommendation`
  field (`"plan"` with `planKind`+`goal`, or `"bug"` with
  `taskTitle`+`taskBody`).
- **Codex-parity acceptance test:** promoting a set of fixture
  findings under `agent=codex` returns a `PromoteRecommendation` with
  a legal `recommendation` value and non-empty required fields for
  that branch. Same fixture under claude is the baseline.
- **Status:** `parity-verified` (post task-019). Promote routes through
  `invokeClaudeJson` with `agent: resolveAgent(db)`. No resume dependency.

### 4d · Audit comment thread agent reply

- **Site:** `apps/daemon/src/audits/comments.ts:93`. Uses shared
  `invokeClaudeJson` with `resumeSessionId: audit.claudeSessionId`.
- **Prompt shape:** short hard-coded prompt that says "Operator just
  asked a follow-up — reply in 1–3 paragraphs of markdown, do not
  re-emit JSON".
- **Output contract parsed:** **plain text** (no JSON envelope
  expected). Body persisted verbatim to `audit_comments`.
- **Resume behavior:** load-bearing — the prompt assumes the resumed
  session still carries the original audit's findings + report in
  context. Without resume, the agent has no idea what audit it's
  being asked about.
- **Codex-parity acceptance test:** under `agent=codex`, posting an
  operator follow-up on a completed audit produces an `agent`-role
  comment that references the audit's subject matter (qualitative —
  verified by the test asserting the reply length > 20 chars and
  does not match the "no captured agent session" fallback string).
- **Status:** `parity-blocked` for the resume axis only (post task-019).
  Behavior under `agent=codex`: the iteration immediately persists an
  `agent`-role comment carrying an actionable hint ("requires session
  resume, which agent codex does not support — switch the project to
  claude-code, or open a fresh audit to re-grow context") and returns.
  The thread stays informative; the operator sees what to do next.
- Follow-up (deferred): rewrite the prompt to inject the audit's
  `reportMarkdown` + findings as full context every turn, so codex can
  participate. Tracked as a `feature_plan` candidate — not blocking
  task-019.

### 4e · Audit prompts & findings parsers (no claude invocation)

- **Sites:** `apps/daemon/src/audits/prompts.ts`,
  `apps/daemon/src/audits/findings.ts`,
  `apps/daemon/src/audits/templates.ts`.
- **Agent dependence:** none. Pure template rendering and JSON
  parsing on a text string produced upstream.
- **Status:** `parity-verified` (agent-agnostic by construction).

---

## 5 — Feedback iteration

### 5a · `runAgentReply` (feedback thread)

- **Site:** `apps/daemon/src/feedback/iterate.ts:82`. Uses shared
  `invokeClaudeJson` with `resumeSessionId: fb.claudeSessionId`
  (`:103`).
- **Prompt shape:** rendered template `feedback-iterate-v1` (with
  fallback at `iterate.ts:178`) — interpolates the feedback body,
  vote, context route/hint, and full thread markdown.
- **Output contract parsed:** **markdown prose followed by a fenced
  JSON block** carrying `FeedbackDraft` = `{kind, title, summary,
  reasoning}`. `extractJsonObject` finds the block; `coerceDraft`
  validates kind ∈ {`plan`,`task`,`dismiss`}. Prose persisted on the
  comment body; draft mirrored on `resultingDraft`.
- **Codex-parity acceptance test:** posting an operator comment on a
  fixture feedback row under `agent=codex` produces (a) an
  `agent`-role `feedback_comments` row with non-empty body, (b)
  `resultingDraft` JSON parses as `FeedbackDraft` with a legal `kind`,
  (c) on a follow-up turn, the draft adapts to the new operator
  comment.
- **Status:** `parity-verified` (post task-019). Feedback iteration
  resolves `agent: resolveAgent(db)` and, when the agent doesn't support
  resume, drops `resumeSessionId` and falls back to the full-prompt path.
  `buildPrompt` already encodes the entire thread into the template, so
  the agent has everything it needs — only token cost increases.

---

## 6 — Other claude invocation sites surfaced during inventory

These are not enumerated in the task's acceptance criterion but were
found during the codebase scan and must be marked to satisfy the
"no indeterminate state" rule.

### 6a · `proposeImportSpec` (spec import → decomposition)

- **Site:** `apps/daemon/src/projects/import-spec.ts:63`. Uses shared
  `invokeClaudeJson` (`:93`).
- **Prompt shape:** template `spec-decompose-v1` with
  `{{SPEC_MARKDOWN}}` + ceremony + role.
- **Output contract parsed:** fenced JSON shaped as
  `SpecDecomposition` (title, summary, tasks[], unknowns[], risks[],
  firstTaskNote). `coerceDecomposition` validates.
- **Codex-parity acceptance test:** decomposing a fixture spec under
  `agent=codex` returns a `SpecDecomposition` with `tasks.length >=
  1` and each task carrying a legal `estimate`. Same fixture under
  claude is the baseline.
- **Status:** `parity-verified` (post task-019). `proposeImportSpec`
  resolves `agent: resolveAgent(db)` and passes it to `invokeClaudeJson`.

### 6b · `recoverFactoryStatusFromLog` (orphan recovery)

- **Site:** `apps/daemon/src/workers/recover.ts:50`. Reads the
  persisted log at `<workdirPath>/.factory/runs/<runId>/log.txt` and
  walks stream-json `assistant`/`result` shapes to extract the final
  factory-status block.
- **Agent dependence:** **claude-specific.** The line parser at
  `recover.ts:67-86` knows only the claude-code stream-json shape
  (`type='assistant'` with `message.content[].text`,
  `type='result'` with `result` string). It will silently emit no
  text for a codex log (whose events are `item.completed` with
  `item.type='agent_message'`).
- **Codex-parity acceptance test:** seeding a daemon-restart scenario
  where a codex run wrote a partial log containing the
  factory-status block, then calling `reapOrphanedRuns`, recovers
  the same `{status, summary, blockerQuestions}` shape as the
  claude case.
- **Status:** `parity-verified` (post task-019). The function now takes
  `agentName` and dispatches log parsing through `extractTextFromLogLine`
  — claude-code stream-json (`type='assistant'` / `type='result'`) and
  codex JSON events (`type='item.completed'` with `item.type='agent_message'`)
  are both handled. The orphan-reap query in `reapOrphanedRuns` selects
  `runs.agent_name` and threads it to the recovery call.

### 6c · `metrics/record.ts` (cost persistence)

- **Site:** `apps/daemon/src/metrics/record.ts:16`. Writes to
  `claude_metrics` table.
- **Agent dependence:** **table is named "claude_metrics" and
  documented as "claude --print invocation's result envelope" — but
  the row schema is agent-agnostic** (cost, tokens, duration,
  modelUsage). Codex writes will record `totalCostUsd=0` (codex
  doesn't report cost) and otherwise populate the same columns.
- **Codex-parity acceptance test:** under `agent=codex`, a run
  produces a `claude_metrics` row with non-zero `inputTokens` and
  `outputTokens` and `totalCostUsd=0`. Metrics dashboards must not
  divide by `totalCostUsd` without a null/zero guard (verified in
  `apps/pwa/src/routes/metrics.tsx`).
- **Status:** `parity-verified` (schema-level — the table accepts
  codex writes). The naming is awkward but a rename is out of scope
  for the parity work; tracking under nominal **task-020** as a
  follow-up rename ("rename `claude_metrics` → `agent_metrics`").

---

## Ship-with-gap policy enforcement

Per task-019's operator-approved policy: `parity-blocked` sites do not
block plan freeze. Instead, when an operator selects `agent=codex` for
a project whose run path goes through any `parity-blocked` site, the
PWA surfaces an actionable error at run-spawn time naming the site and
linking back to this document. Implementation lives in the project
agent-picker UI (**task-020**) and the submit-time precheck in
`apps/daemon/src/workers/submit.ts`.

---

## Summary table

| # | Site | File:line | Status | Blocker | Follow-up |
|---|---|---|---|---|---|
| 0a | claude-code provider | `packages/runtime/src/agents/claude-code.ts:148` | parity-verified | provider-level fixture-replay test still optional | — |
| 0b | codex provider | `packages/runtime/src/agents/codex.ts:37` | parity-verified | callers dispatch via resolveAgent | task-020 (per-project picker) |
| 1a | runner.ts spawn | `apps/daemon/src/workers/runner.ts:286` | parity-verified | dispatches via `agentForRow(row.agentName)` | — |
| 1b | submit.ts row insert | `apps/daemon/src/workers/submit.ts` | parity-verified (fresh) / parity-blocked (resume) | resume paths under codex are refused with actionable error | task-020 |
| 1c | runtime.ts spawn entry | `packages/runtime/src/runtime.ts:81` | parity-verified | — | — |
| 2a | runTriage | `apps/daemon/src/triage/orchestrate.ts` | parity-verified | dispatches via `resolveAgent(db)` | — |
| 2b | runFollowupTriage | `apps/daemon/src/triage/orchestrate.ts` | parity-verified | same | — |
| 3a | shared invokeClaudeJson | `apps/daemon/src/plans/invoke-claude.ts` | parity-verified | dispatches on `opts.agent`, throws `ResumeUnsupportedError` for incompatible resume | — |
| 3b | runPlanIteration (×5 kinds) | `apps/daemon/src/plans/iterate.ts` | parity-verified (fresh + follow-up) | resume branch suppressed under codex; falls back to full prompt | — |
| 3c | plan-freeze applicators | `apps/daemon/src/plans/{refine,bootstrap-from-plan,apply-feature-plan,apply-project-vision}.ts` | parity-verified | no agent code | — |
| 4a | runAuditIteration | `apps/daemon/src/audits/iterate.ts` | parity-verified | dispatch via resolveAgent | — |
| 4b | runExecAudit | `apps/daemon/src/audits/exec-iterate.ts` | parity-verified | dispatch via resolveAgent | — |
| 4c | bridgePromoteFindings | `apps/daemon/src/audits/promote.ts` | parity-verified | dispatch via resolveAgent | — |
| 4d | audit comment reply | `apps/daemon/src/audits/comments.ts` | parity-blocked (resume axis) | codex has no resume; replies under codex emit an in-thread "switch agent" hint | deferred (full-context prompt rewrite) |
| 4e | audit prompts/findings | `apps/daemon/src/audits/{prompts,findings,templates}.ts` | parity-verified | agent-agnostic parsers | — |
| 5a | feedback agent reply | `apps/daemon/src/feedback/iterate.ts` | parity-verified | dispatch + drops resume under codex; full thread already in prompt | — |
| 6a | proposeImportSpec | `apps/daemon/src/projects/import-spec.ts` | parity-verified | dispatch via resolveAgent | — |
| 6b | recoverFactoryStatusFromLog | `apps/daemon/src/workers/recover.ts` | parity-verified | dispatches on `runs.agentName` via `extractTextFromLogLine` | — |
| 6c | claude_metrics writer | `apps/daemon/src/metrics/record.ts:16` | parity-verified | schema accepts codex writes; rename deferred | task-020 |
