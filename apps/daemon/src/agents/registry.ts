import {
  type AgentSpec,
  claudeCodeAgent,
  codexAgent,
  createClaudeCodeAgent,
} from "@factory/runtime";
import { z } from "zod";
import { probeCodexAuth } from "./codex-auth.ts";

/**
 * Single source of truth for every agent Factory dispatches to. Adding a new
 * harness (kimi, qwen, local-ollama, …) is a single drop-in `AgentDescriptor`
 * entry below — every consumer (tRPC enums, model picker, session launcher,
 * factory doctor, run submission auth probes, follow-up resume-parity guards)
 * reads from this registry instead of switching on the agent id.
 *
 * Before this consolidation the agent id was hardcoded in ~8 separate places.
 * The "ad-hoc sessions only offer Claude or shell" miss was the smoking gun:
 * it's not that someone forgot codex, it's that the design let you forget.
 *
 * # How to add a new agent
 *
 * 1. Add the id to {@link AGENT_NAMES} (the const tuple — the rest of the
 *    types derive from it).
 * 2. Write a runtime {@link AgentSpec} in `packages/runtime/src/agents/` so
 *    the daemon can spawn it under `runtime.spawn` for code-changing runs.
 * 3. Register an entry in {@link AGENT_REGISTRY} below with the descriptor
 *    metadata (label, models, support flags, auth probe, interactive launch
 *    command).
 *
 * Everything else (PWA picker, session pane, parity gates, run-spawn auth
 * probe) picks it up automatically because every other site reads from this
 * file.
 *
 * # Known gap
 *
 * `apps/cli/src/commands/doctor.ts` still embeds a hardcoded codex auth check
 * rather than iterating the registry. The CLI is a separate workspace and
 * can't import from `apps/daemon` without a packages/-level extraction.
 * Adding a third agent that needs a doctor probe requires touching `doctor.ts`
 * as well — file this as a follow-up to lift the registry into a shared
 * package when a third harness lands.
 */

/** The canonical const tuple of supported agent ids. */
export const AGENT_NAMES = ["claude-code", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Tuple form for `z.enum`. Cast asserts the at-least-one-element constraint. */
export const AGENT_ID_TUPLE = AGENT_NAMES as readonly string[] as [AgentName, ...AgentName[]];

/**
 * The single agent-id zod enum. Routers/inputs MUST use this rather than re-typing
 * `z.enum(["claude-code","codex"])` — adding a family is then one edit to AGENT_NAMES,
 * not a hunt across every router (ADR-015).
 */
export const AGENT_NAME_ENUM = z.enum(AGENT_ID_TUPLE);

export interface AgentModel {
  /** `null` = "let the agent's CLI pick its own default". */
  id: string | null;
  label: string;
  hint: string;
}

export interface AgentAuthStatus {
  ok: boolean;
  detail: string;
  /** Filesystem path the operator should look at if `ok=false`. */
  configPath?: string;
}

export interface AgentDescriptor {
  id: AgentName;
  /** Short label for chips, dropdowns, doctor output. Lowercase by convention. */
  label: string;
  /** One-line description shown next to the label in pickers / doctor. */
  hint: string;
  /** Selectable models in the PWA picker (`{id: null}` = CLI default). */
  models: ReadonlyArray<AgentModel>;
  /** Capability flags consumers query before dispatching down a code path. */
  supports: {
    /** CLI supports `--resume <session-id>` to thread a prior conversation. */
    resume: boolean;
    /** Can be launched as an interactive session for the session pane / xterm. */
    interactiveSession: boolean;
  };
  /** Runtime spec used by `runtime.spawn` for code-changing runs. */
  runtimeSpec: AgentSpec;
  /**
   * Build the runtime spec optionally bound to the run's worktree — claude-code
   * uses it for tool-summary path context. Falls back to `runtimeSpec` when
   * omitted, so the runner never special-cases a family (ADR-015).
   */
  runtimeSpecFor?: (worktreePath?: string) => AgentSpec;
  /**
   * Optional auth probe — returns `null` when no probe is meaningful (agent
   * is always usable, e.g. claude-code where auth is operator-managed and
   * the daemon assumes it's set up). Returns `{ok: false, …}` when the
   * agent is configured but unauthorized; callers refuse to spawn.
   */
  probeAuth?: () => AgentAuthStatus | null;
  /**
   * Build the inner shell command for an interactive session pane (tmux pty).
   * Only required when `supports.interactiveSession=true`. The result is run
   * via `sh -c`, so any shell-friendly form works. The session orchestrator
   * still wraps with `sleep 0.15;` and `exec` to defeat pty races.
   */
  buildInteractiveCommand?: () => string;
  /**
   * The family to use as the cross-model validator for runs this family built
   * (ADR-014/015). Each family declares its own validator, so the pairing is
   * registry-derived, not a hardcoded map that breaks at a third family.
   * `null`/omitted = no cross-model validation for this family.
   */
  validatorAgentId?: AgentName | null;
  /** One-line guidance shown when `probeAuth` fails — how to authenticate this family. */
  authGuideText?: string;
}

const claudeCodeDescriptor: AgentDescriptor = {
  id: "claude-code",
  label: "claude",
  hint: "anthropic claude code",
  models: [
    { id: null, label: "default", hint: "claude cli's choice" },
    { id: "claude-opus-4-8", label: "opus 4.8", hint: "most capable" },
    { id: "claude-opus-4-7", label: "opus 4.7", hint: "prior flagship" },
    { id: "claude-sonnet-5", label: "sonnet 5", hint: "balanced" },
    { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fast / cheap" },
  ],
  supports: { resume: true, interactiveSession: true },
  validatorAgentId: "codex",
  runtimeSpec: claudeCodeAgent,
  runtimeSpecFor: (worktreePath) => createClaudeCodeAgent(worktreePath),
  // No probeAuth: claude-code's auth is operator-managed (ANTHROPIC_API_KEY
  // or claude login). We assume the daemon's host has it set up; mid-run
  // auth failures surface in the pane output.
  buildInteractiveCommand: () => "exec claude",
};

const codexDescriptor: AgentDescriptor = {
  id: "codex",
  label: "codex",
  hint: "openai codex (chatgpt subscription)",
  /**
   * Source of truth: `~/.codex/models_cache.json` (the codex CLI's own list).
   * Skipping `gpt-5.2` (older) and `codex-auto-review` (hidden / internal).
   */
  models: [
    { id: null, label: "default", hint: "codex cli's choice" },
    { id: "gpt-5.5", label: "gpt-5.5", hint: "frontier · complex coding" },
    { id: "gpt-5.4", label: "gpt-5.4", hint: "everyday coding" },
    { id: "gpt-5.4-mini", label: "5.4 mini", hint: "fast / cheap" },
    { id: "gpt-5.3-codex", label: "5.3 codex", hint: "codex-tuned" },
  ],
  // Codex has no `--resume <session>` equivalent yet — follow-up flows must
  // rebuild the full prompt. See docs/internal/codex-parity.md.
  supports: { resume: false, interactiveSession: true },
  validatorAgentId: "claude-code",
  authGuideText: 'See README.md "Using codex (ChatGPT subscription)" for the one-time login flow.',
  runtimeSpec: codexAgent,
  probeAuth: () => {
    const status = probeCodexAuth();
    return {
      ok: status.ok,
      detail: status.ok ? `authed (${status.authPath})` : (status.reason ?? "unauthorized"),
      configPath: status.authPath,
    };
  },
  buildInteractiveCommand: () => "exec codex",
};

export const AGENT_REGISTRY: Record<AgentName, AgentDescriptor> = {
  "claude-code": claudeCodeDescriptor,
  codex: codexDescriptor,
};

/**
 * Experimental claude-code model, gated behind the `experimental-fable-5` user
 * setting. It is *not* baked into {@link claudeCodeDescriptor} because the model
 * picker should only offer it to operators who opted in — `agents.list` appends
 * it to the claude-code model list when the flag is on (see `routers/agents.ts`).
 * Run submission treats model ids as opaque, so a selected Fable 5 run still
 * dispatches even if the operator later toggles the flag back off.
 */
export const FABLE_5_MODEL: AgentModel = {
  id: "claude-fable-5",
  label: "fable 5",
  hint: "experimental",
};

/** Cheap typed lookup. Returns `null` for unknown ids — callers should guard. */
export function getAgentDescriptor(id: string | null | undefined): AgentDescriptor | null {
  if (typeof id !== "string") return null;
  return (AGENT_REGISTRY as Record<string, AgentDescriptor | undefined>)[id] ?? null;
}

/**
 * Which agent's model set claims this model id, or `null` if no registered
 * agent lists it. Used by the run-submit backstop to detect a cross-agent
 * model id (e.g. a `claude-*` id resolved onto a codex run) so it can be
 * dropped before the provider chokes on it. Intentionally returns `null` for
 * ids no descriptor lists (experimental/gated models like Fable 5, or future
 * ids) — submission treats those as opaque pass-through, so they're left
 * untouched rather than clamped.
 */
export function agentForModel(modelId: string): AgentName | null {
  for (const name of AGENT_NAMES) {
    if (AGENT_REGISTRY[name].models.some((m) => m.id === modelId)) return name;
  }
  return null;
}

/**
 * Run-submit cross-agent backstop. Returns `model` unchanged unless it is
 * definitively owned by a *different* registered agent than `agent`, in which
 * case it returns `null` so the resolved agent falls back to its own default.
 * A model id no descriptor claims (experimental/gated like Fable 5, or a future
 * id) is treated as opaque and passes through untouched. Pulled out as a pure
 * function so the clamp decision is unit-testable independent of `submitRun`.
 */
export function clampModelToAgent(agent: AgentName, model: string | null): string | null {
  if (!model) return model;
  const owner = agentForModel(model);
  return owner && owner !== agent ? null : model;
}

/**
 * Throws if the agent id isn't supported. Used at the boundary between
 * untrusted input (DB rows, request payloads) and code that wants a typed
 * AgentName narrowly. Prefer {@link getAgentDescriptor} when missing is
 * recoverable (settings fallback to claude-code, etc.).
 */
export function requireAgentDescriptor(id: string): AgentDescriptor {
  const d = getAgentDescriptor(id);
  if (!d) throw new Error(`unknown agent "${id}" — not in AGENT_REGISTRY`);
  return d;
}

/** All registered descriptors, in declaration order. Used by `factory doctor`, picker. */
export const ALL_AGENT_DESCRIPTORS: ReadonlyArray<AgentDescriptor> = AGENT_NAMES.map(
  (n) => AGENT_REGISTRY[n],
);
