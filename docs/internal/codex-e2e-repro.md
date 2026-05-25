# Codex provider — end-to-end manual repro

Verifies that a code-changing run with `agent: codex` honors the same
contract as the claude path: tmux+worktree spawn, agent-driven commits,
`factory-status` parse, auto-merge to `main` on success, null-parse-fail
discipline.

Pair with the integration test at
`apps/daemon/test/codex-factory-status.test.ts`, which pins the
codex→factory-status data flow without requiring the operator to spin up
a live run.

## Prerequisites

- `codex --version` resolves (the binary lives on `$PATH`).
- `codex login status` reports `Logged in using ChatGPT` — subscription
  auth, no `OPENAI_API_KEY` required. See ADR-006 §"Authentication — CLI path".
- A Factory project exists with a clean `main` and at least one
  `.factory/work/task-XXX-*.md` file you don't mind running.

## A — Happy path (agent declares `done` → auto-merges to `main`)

1. Pick a small task and pin the agent to codex by setting frontmatter:
   ```yaml
   ---
   id: task-NNN
   title: smoke — codex provider e2e
   status: ready
   agent: codex
   # model omitted → CLI default. Set `model: gpt-5-codex` or similar to override.
   ---
   ```
   Task body should be something codex can finish in one turn, e.g.
   "Append a single blank line to README.md and commit."

2. From the PWA, submit the task (or call `runs.submit`). The submit
   path picks up `agent: codex` from the frontmatter and stores
   `agent_name = "codex"` on the run row
   (`apps/daemon/src/workers/submit.ts` `normalizeAgent`).

3. Watch the run pane (`/runs/:id`). You should see:
   - `thread.started` line carrying a `thread_id` (this becomes
     `runs.session_id`).
   - `item.started` events for each tool call codex dispatches.
   - `item.completed` events with `type: agent_message` text.
   - `turn.completed` carrying the usage block (input/output/cached
     tokens; `total_cost_usd` will be 0 — codex doesn't report cost).
   - A fenced `factory-status` block in the final agent message
     declaring `done`.

4. After the run finishes verify:
   - **Run status:** `completed` on the run row.
   - **Branch:** `factory/run-<runId>` exists with the agent's commit(s).
   - **Main moved:** `git log main` on the project workdir shows a
     `chore(task-NNN): …` merge commit with the `Factory-Run` /
     `Factory-Task` / `Factory-Status: completed` trailers. Without this
     merge, the project's `main` would never advance and auto-advance
     wouldn't compound — the same v0.1 contract `runner.ts` enforces for
     claude runs.
   - **Worktree cleaned up:** `~/.factory/worktrees/<slug>/<runId>/`
     is gone; the branch ref remains.
   - **Task file flipped:** `.factory/work/task-NNN-*.md` frontmatter
     status moved from `ready` → `done` and the bump rode the merge.

## B — Null-parse-fail discipline (no footer → `failed`, never `completed`)

Goal: prove the daemon does not silently mark a codex run `completed`
when codex omits the factory-status footer.

1. Reuse the same task but rewrite the body so codex will NOT emit a
   footer. Easiest: put a one-liner like "Just print 'ok' and exit. Do
   not emit any factory-status block." (The codex CLI doesn't strip
   protocol footers — the wrap-up footer comes from Factory's
   `wrapPrompt`, so we're explicitly telling the agent to ignore it.)

2. Submit. The run will proceed through the normal stream, then end
   with `turn.completed`.

3. Verify:
   - **Run status:** `failed` on the run row.
   - **Summary:** "Run ended without a status block — the agent may have
     stopped early." (set by the fallback branch in `runner.ts`).
   - **Decision card:** the `blocked_run` decision was inserted with
     `payload.failed = true` — surfaces in the inbox so the operator
     notices instead of having to grep run rows.
   - **Main did NOT move:** `git log main` shows no new merge for this
     task. The whole point — silent completion would have folded
     un-verified work into `main`.

## C — Per-run model override

1. Edit the same task and set `model: gpt-5-codex` (or whatever model id
   the operator wants to pin to).

2. Submit. The new run row carries `model = "gpt-5-codex"`. The runner
   passes it via `runtime.spawn({ model })` and the codex provider's
   `buildArgv` adds `--model gpt-5-codex` to the argv. Confirm via the
   run pane's first line (`[runtime] argv: codex exec --json
   --dangerously-bypass-approvals-and-sandbox --model gpt-5-codex`) or
   by `select model from runs where id = ?`.

3. Clear the frontmatter `model` field and resubmit. The new run's
   argv omits `--model`, deferring to the CLI default (acceptance:
   `null` model → provider default).

## D — Confirm structural guarantees without running

If a live codex run isn't feasible (offline, no subscription),
`bun test apps/daemon/test/codex-factory-status.test.ts` runs the four
data-flow tests:

- agent_message with a footer → `parseFactoryStatus` returns the parsed
  block (happy path).
- agent_message with a `blocked` footer → parsed with questions
  surfaced (operator-attention path).
- agent_message with no footer at all → `parseFactoryStatus` returns
  `null` (the input to `runStatusFor(null, false) === "failed"`).
- Footer split across multiple agent_message events still parses
  (pins the accumulation contract).

The unit tests at `packages/runtime/test/agents/codex.test.ts` cover
provider-level behavior (argv build, line parse, staleness, usage
limit).

## Known limitations

- **No session resume.** Codex `exec` has no `--resume` flag. The
  usage-limit auto-resume path in `runner.ts` does nothing useful for
  codex runs — a codex run that hits a cap surfaces as a
  `blocked_run` decision rather than parking. See ADR-006 §"Session
  resume".
- **No per-call cost.** `runs.total_cost_usd` is 0 for codex runs.
  Cost dashboards will show a flat $0 for the codex provider.
- **Stderr noise.** Codex emits non-fatal lines like `failed to record
  rollout items` on stderr; `parseLine` ignores non-JSON, so this
  doesn't affect run status — only log volume.
