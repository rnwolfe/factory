# ADR-006 — Codex agent harness: CLI over (non-existent) SDK

**Status:** Accepted  
**Date:** 2026-05-25  
**Deciders:** Ryan Wolfe  
**Spike task:** task-016

---

## Context

Factory runs code-changing tasks by spawning an AI agent in a tmux+worktree
sandbox and streaming its output line-by-line. Claude Code is the current
agent, invoked as `claude --print --output-format stream-json`. The operator
wants to add OpenAI Codex as an alternative agent so Factory can use the
ChatGPT subscription for runs instead of (or in addition to) the Claude
subscription.

The feature plan (nt7386gu) left open the question of whether to drive Codex
via a programmatic **SDK** (importing it as a library) or via the **CLI**
(spawning `codex exec` as a subprocess). The acceptance criterion was:
"defaults to SDK; only falls back to CLI if SDK cannot authenticate via
ChatGPT subscription in a non-interactive systemd-managed daemon context."

---

## Investigation

### SDK vs CLI

`@openai/codex` v0.125.0 (installed at
`~/.local/share/mise/installs/node/24.12.0/lib/node_modules/@openai/codex`)
**exposes no importable API**. Its `package.json` has no `main`, no `exports`
map, and a single `bin` entry:

```json
"bin": { "codex": "bin/codex.js" }
```

There is no programmatic SDK. The "SDK path" from the acceptance criterion does
not exist. The CLI is the only option.

### Authentication in a headless daemon context

```
$ codex login status
Logged in using ChatGPT
```

The credential is a persistent token stored in `~/.codex/auth.json`, written
on first `codex login` (browser OAuth flow). Subsequent invocations — including
non-interactive daemon invocations — read this token without prompting. The
file is owned by the operator user, so any process running as that user (e.g.
`factoryd.service` with `User=rnwolfe`) authenticates transparently.

No `OPENAI_API_KEY` is needed. ChatGPT subscription billing applies.

**Conclusion:** CLI auth via ChatGPT subscription works in non-interactive,
systemd-managed daemon context.

### Non-interactive execution and sandbox posture

`codex exec` is the non-interactive subcommand. The relevant flags:

| Flag | Purpose |
|------|---------|
| `--json` | Emit JSONL events to stdout (same role as `--output-format stream-json` for Claude) |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all confirmation prompts and run commands without the OS-level sandbox. Intended for externally-sandboxed environments. |
| `--model <name>` | Override default model per-run |
| `-C <dir>` | Set working root (not used; Factory cds to worktreePath via tmux) |

`--dangerously-bypass-approvals-and-sandbox` is the **codex equivalent of
Claude's `--dangerously-skip-permissions`**. The same rationale applies:
Factory's isolation boundary is the per-run git worktree, not the CLI's
permission gate. When a real container sandbox lands, this flag goes away.

### Streaming and JSON event format

`codex exec --json` emits newline-delimited JSON. Events relevant to Factory:

| Event type | Meaning |
|-----------|---------|
| `thread.started` + `thread_id` | Session ID for the run |
| `turn.started` | Turn begins (no action needed) |
| `item.started` + `type: command_execution` | Tool call dispatched |
| `item.completed` + `type: agent_message` | Agent text output |
| `item.completed` + `type: command_execution` | Tool call finished |
| `turn.completed` + `usage` | Run done; carries token counts |

Output is streamed incrementally — `item.started` fires before the command
executes, `item.completed` fires when it finishes. Agent text arrives as a
single `item.completed` block (no per-token streaming). Both proofs confirmed
via live invocations.

### Proof — one-shot invocation (subscription auth, headless)

```
$ echo "Say 'hello world' and nothing else." \
    | codex exec --json --dangerously-bypass-approvals-and-sandbox -
{"type":"thread.started","thread_id":"019e603f-0fc8-7d42-a0d3-264f495beb02"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello world"}}
{"type":"turn.completed","usage":{"input_tokens":19293,"cached_input_tokens":2432,"output_tokens":6,"reasoning_output_tokens":0}}
```

Exit code 0. Stderr emits a non-fatal telemetry recording error that can be
safely ignored.

### Proof — streamed invocation with tool use

```
$ echo "List the files in the current directory and tell me how many there are." \
    | codex exec --json --dangerously-bypass-approvals-and-sandbox -
{"type":"thread.started",...}
{"type":"turn.started"}
{"type":"item.started","item":{"type":"command_execution","command":"..."}}
{"type":"item.completed","item":{"type":"command_execution",...}}
{"type":"item.completed","item":{"type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{...}}
```

`item.started` fires ahead of `item.completed`, confirming that tool-call
events stream ahead of the result. This is sufficient for the pane xterm.js
display — raw bytes are forwarded via `kind: "raw"` events regardless of parsed
events.

### Session resume

Codex has no `--resume <sessionId>` flag. The `resumeSessionId` option in
`AgentSpec.buildArgv` is silently ignored by the codex provider. Factory's
usage-limit resume path will not work for codex runs; a run that hits a cap
will fail rather than resume.

### Cost visibility

`turn.completed` reports token counts (`input_tokens`, `cached_input_tokens`,
`output_tokens`, `reasoning_output_tokens`) but **no cost in USD**. The
`AgentMetrics.totalCostUsd` field is reported as `0`. The metrics row in the
DB will show token counts; cost dashboards will show zero for codex runs until
OpenAI exposes cost in the event stream.

---

## Decision

Use `codex exec --json --dangerously-bypass-approvals-and-sandbox` as a
subprocess, identical in pattern to the Claude CLI path. Implement as a new
`AgentSpec` (`codexAgent`) at `packages/runtime/src/agents/codex.ts`. Export
from the runtime package alongside `claudeCodeAgent`.

The "SDK vs CLI" framing from the acceptance criterion resolves automatically:
no SDK exists, so the CLI is the only viable path.

---

## Consequences

**Positive**
- ChatGPT subscription can be used for Factory runs with no API key.
- Pattern is identical to the existing Claude harness — no new runtime
  infrastructure required.
- Auth persists across daemon restarts; no interactive re-auth in normal use.

**Negative / Limitations**
- No session resume: codex runs that hit a usage cap fail rather than
  parking and resuming when the cap lifts.
- No per-call cost reporting: cost dashboards show zero for codex runs.
- Model selection strings differ from Claude (e.g. `gpt-5.5` not `claude-…`);
  the per-project model picker must surface provider-appropriate choices.
- Non-fatal stderr noise (`failed to record rollout items`) clutters logs;
  parseLine ignores non-JSON lines so it doesn't affect event parsing.

---

## Alternatives considered

| Alternative | Rejected because |
|-------------|-----------------|
| Programmatic SDK | Does not exist; `@openai/codex` exports no importable API |
| API key auth | Requires operator to obtain and manage an API key; feature request is specifically about subscription billing |
| Codex Cloud (`codex cloud` subcommand) | Experimental, requires separate cloud account; not relevant to local daemon use case |
