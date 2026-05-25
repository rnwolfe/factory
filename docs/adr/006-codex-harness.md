# ADR-006 — Codex agent harness: raw CLI spawn (SDK exists but is a thin wrapper)

**Status:** Accepted (revised — task-021 corrected a factual error in the original)
**Date:** 2026-05-25  
**Deciders:** Ryan Wolfe  
**Spike task:** task-016 (initial), task-021 (SDK re-evaluation)

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

### SDK vs CLI — corrected record (task-021)

The original task-016 spike examined `@openai/codex` (the CLI package) and
correctly found it has no importable API. It incorrectly concluded that "no
programmatic SDK exists."

**The operator was right**: there is a distinct npm package, `@openai/codex-sdk`
(v0.133.0 as of 2026-05-25), documented at `developers.openai.com/codex/sdk`.
It is importable:

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex(); // subscription auth; no apiKey needed
const thread = codex.startThread({ approvalPolicy: "never" });
const turn = await thread.run("Say hello and nothing else.");
console.log(turn.finalResponse);
```

**However**, `@openai/codex-sdk` is architecturally a thin process wrapper: it
spawns the `@openai/codex` CLI binary as a subprocess running
`codex exec --experimental-json`, reads JSONL from stdout, and surfaces typed
TypeScript events. It is not a direct HTTP REST client. The `@openai/codex`
binary must be installed on the host regardless of which path is used.

### Authentication — SDK path

`CodexOptions.apiKey` sets `CODEX_API_KEY` in the spawned process's
environment (OpenAI API key billing). If `apiKey` is omitted, the CLI
inherits `process.env` and reads `~/.codex/auth.json` as normal. **ChatGPT
subscription auth works with the SDK** — the SDK does not override auth unless
you explicitly pass `apiKey`.

### Authentication — CLI path (confirmed in task-016)

```
$ codex login status
Logged in using ChatGPT
```

The credential is a persistent token stored in `~/.codex/auth.json`, written
on first `codex login` (browser OAuth flow). Subsequent non-interactive daemon
invocations read this token without prompting. Auth persists across daemon
restarts; any process running as the operator user authenticates transparently.

No `OPENAI_API_KEY` is needed. ChatGPT subscription billing applies.

**Both paths authenticate via subscription in non-interactive, systemd-managed
daemon context.** Auth is not the differentiator.

### Non-interactive execution and sandbox posture

`codex exec` is the non-interactive subcommand. The relevant flags for raw CLI:

| Flag | Purpose |
|------|---------|
| `--json` | Emit JSONL events to stdout |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all confirmation prompts and sandbox. Equivalent of Claude's `--dangerously-skip-permissions`. |
| `--model <name>` | Override default model per-run |

SDK equivalent: `approvalPolicy: "never"` on `startThread()`. The SDK emits
`--experimental-json` instead of `--json`; these appear to be the same event
format but the flag name differs.

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

The SDK's TypeScript types (`ThreadEvent`, `ThreadItem`) describe the same
event schema.

### Proof — one-shot invocation (subscription auth, headless)

```
$ echo "Say 'hello world' and nothing else." \
    | codex exec --json --dangerously-bypass-approvals-and-sandbox -
{"type":"thread.started","thread_id":"019e603f-0fc8-7d42-a0d3-264f495beb02"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello world"}}
{"type":"turn.completed","usage":{"input_tokens":19293,"cached_input_tokens":2432,"output_tokens":6,"reasoning_output_tokens":0}}
```

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

### Session resume

Codex has no `--resume <sessionId>` flag on `exec`. The SDK's
`resumeThread(id)` resumes a thread stored in `~/.codex/sessions` — this is a
Codex-internal concept, not the same as Factory's `resumeSessionId` (which is
for usage-limit pause/resume). Factory's usage-limit resume path will not work
for codex runs; a run that hits a cap fails rather than parks.

### Cost visibility

`turn.completed` reports token counts but **no cost in USD**. `AgentMetrics.totalCostUsd`
is reported as `0`. This limitation applies to both CLI and SDK paths.

---

## Decision

Use `codex exec --json --dangerously-bypass-approvals-and-sandbox` as a
subprocess, spawned directly (not via `@openai/codex-sdk`). Implemented at
`packages/runtime/src/agents/codex.ts`.

**Rationale for raw CLI over SDK:**

1. `@openai/codex-sdk` is a process wrapper around the same CLI binary —
   using it adds a package dependency without changing the underlying
   mechanism. Both paths spawn `codex exec`.

2. The raw CLI path was already validated (task-016) and implemented
   (task-018). Switching to the SDK wrapper would require migrating to
   `--experimental-json` and testing an unfamiliar flag.

3. The SDK's main value proposition — TypeScript event types — is already
   covered by the `CodexStreamLine` interface in `agents/codex.ts`. The
   event schema is identical.

4. Subscription auth works on both paths. SDK is not required for
   subscription billing.

If Factory ever needs to embed Codex in a non-CLI context (e.g., an Electron
app that must control the env completely), migrating to `@openai/codex-sdk` is
a one-file change at the agent provider seam.

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
- Model selection strings differ from Claude (e.g. `codex-1` not `claude-…`);
  the per-project model picker must surface provider-appropriate choices.
- Non-fatal stderr noise (`failed to record rollout items`) clutters logs;
  `parseLine` ignores non-JSON lines so it doesn't affect event parsing.

---

## Alternatives considered

| Alternative | Rejected because |
|-------------|-----------------|
| `@openai/codex-sdk` (task-021 finding) | Thin wrapper around same CLI binary; adds dependency without changing mechanism; CLI path already implemented |
| API key auth | Requires operator to obtain and manage an API key; feature request is specifically about subscription billing |
| Codex Cloud (`codex cloud` subcommand) | Experimental, requires separate cloud account; not relevant to local daemon use case |
