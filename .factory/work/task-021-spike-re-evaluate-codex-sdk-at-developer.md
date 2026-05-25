---
id: task-021
title: "Spike: re-evaluate Codex SDK at developers.openai.com/codex/sdk against
  subscription auth (revisit ADR-006)"
status: done
priority: med
estimate: medium
created: 2026-05-25T21:38:57.511Z
updated: 2026-05-25T22:00:00.000Z
labels:
  - refinement-followup
parent: task-016
---

## Acceptance

- [x] Operator was correct: `@openai/codex-sdk` (v0.133.0) exists as a distinct npm package and was not evaluated in task-016
- [x] SDK surface documented: `import { Codex } from "@openai/codex-sdk"`, `new Codex()`, `startThread()`, `thread.run()`
- [x] Subscription auth verdict: works — SDK inherits CLI's `~/.codex/auth.json` when `apiKey` is omitted; subscription billing applies
- [x] Architecture finding: SDK is a thin wrapper that spawns `codex exec --experimental-json`; same underlying mechanism as the raw CLI path
- [x] ADR-006 updated to correct the "no SDK exists" error and document why raw CLI remains the implementation choice

## Findings

### The operator was right
`@openai/codex-sdk` is a real, importable package distinct from `@openai/codex`.
Task-016 only inspected `@openai/codex` (the CLI package) and missed it.

### What the SDK is
A TypeScript process wrapper. It spawns `@openai/codex` CLI as a subprocess
running `codex exec --experimental-json`, then surfaces typed events:

```typescript
import { Codex } from "@openai/codex-sdk";
const codex = new Codex(); // no apiKey = subscription auth via ~/.codex/auth.json
const thread = codex.startThread({ approvalPolicy: "never" }); // headless mode
const turn = await thread.run("prompt");
console.log(turn.finalResponse); // typed result
```

### Auth
- `new Codex({ apiKey: "sk-..." })` → API key billing via `CODEX_API_KEY` env
- `new Codex()` (no apiKey) → inherits CLI auth state → **subscription billing**
- Subscription auth in headless daemon: confirmed working (same as CLI path)

### Implementation decision: keep raw CLI
The SDK wraps the same binary the current `agents/codex.ts` already calls.
Switching to the SDK would add a package dependency (`@openai/codex-sdk` which
depends on `@openai/codex`) and migrate to `--experimental-json` flag — no
material benefit over the already-implemented raw CLI approach.

ADR-006 revised to reflect this. See `docs/adr/006-codex-harness.md`.

## Notes

Follow-up emitted by refinement plan against task-016. Operator note: Operator disputes the prior spike's conclusion that no importable Codex SDK exists, citing https://developers.openai.com/codex/sdk as evidence of an official SDK that was not evaluated. The prior run investigated the `@openai/codex` npm package and found only a CLI surface; the URL the operator provided appears to point to a distinct SDK product (likely a different package or distribution) that the spike never opened. Operator wants the SDK path re-investigated against that specific documentation before CLI-only is locked in.

