import { cn } from "../lib/cn.ts";

export type AgentName = "claude-code" | "codex";

export interface ModelOption {
  id: string | null;
  label: string;
  hint: string;
}

/**
 * Models selectable per agent. The `null` entry lets the agent's CLI pick its
 * own default. Keep claude entries in sync with what `claude --model` accepts;
 * codex entries should mirror the visible, API-supported models in codex's
 * own `~/.codex/models_cache.json`. The cache lives next to the codex CLI's
 * config and is the most authoritative list — run `codex doctor` to see the
 * active model, or `cat ~/.codex/models_cache.json` for the full lineup
 * with priorities and visibility flags.
 */
export const MODELS_BY_AGENT: Record<AgentName, ReadonlyArray<ModelOption>> = {
  "claude-code": [
    { id: null, label: "default", hint: "claude cli's choice" },
    { id: "claude-opus-4-7", label: "opus 4.7", hint: "max capability" },
    { id: "claude-sonnet-4-6", label: "sonnet 4.6", hint: "balanced" },
    { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fast / cheap" },
  ],
  codex: [
    { id: null, label: "default", hint: "codex cli's choice" },
    { id: "gpt-5.5", label: "gpt-5.5", hint: "frontier · complex coding" },
    { id: "gpt-5.4", label: "gpt-5.4", hint: "everyday coding" },
    { id: "gpt-5.4-mini", label: "5.4 mini", hint: "fast / cheap" },
    { id: "gpt-5.3-codex", label: "5.3 codex", hint: "codex-tuned" },
  ],
} as const;

export const AGENT_OPTIONS: ReadonlyArray<{ id: AgentName; label: string; hint: string }> = [
  { id: "claude-code", label: "claude", hint: "anthropic claude code" },
  { id: "codex", label: "codex", hint: "openai codex (chatgpt subscription)" },
];

/**
 * Back-compat alias. The legacy ModelPicker had a flat MODEL_OPTIONS list
 * (claude only). Callers that still import it get claude's options. Prefer
 * AgentModelPicker for new callers.
 */
export const MODEL_OPTIONS = MODELS_BY_AGENT["claude-code"];

/**
 * Fused {agent, model} picker. Agent radio sits above a per-agent model row;
 * picking a different agent resets model selection to that agent's default
 * (null) — codex model ids don't make sense under claude and vice versa.
 *
 * `agent=null` and `model=null` both mean "inherit from the next layer up"
 * (settings → "claude-code" for agent; provider CLI default for model).
 */
export function AgentModelPicker({
  agent,
  model,
  onAgentChange,
  onModelChange,
  disabled,
}: {
  agent: AgentName | null | undefined;
  model: string | null | undefined;
  onAgentChange: (agent: AgentName) => void;
  onModelChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const effectiveAgent: AgentName = (agent ?? "claude-code") as AgentName;
  const models = MODELS_BY_AGENT[effectiveAgent] ?? MODELS_BY_AGENT["claude-code"];
  return (
    <div className="space-y-2" data-card-skip-open>
      <div className="flex flex-wrap gap-1.5">
        {AGENT_OPTIONS.map((opt) => {
          const selected = effectiveAgent === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                if (opt.id === effectiveAgent) return;
                onAgentChange(opt.id);
                onModelChange(null);
              }}
              disabled={disabled}
              title={opt.hint}
              className={cn(
                "chip mono cursor-pointer",
                selected ? "chip-accent" : "",
                disabled ? "opacity-50 cursor-not-allowed" : "",
              )}
              data-card-skip-open
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {models.map((opt) => {
          const selected = (model ?? null) === opt.id;
          return (
            <button
              key={opt.id ?? "default"}
              type="button"
              onClick={() => onModelChange(opt.id)}
              disabled={disabled}
              title={opt.hint}
              className={cn(
                "chip mono cursor-pointer text-[11px]",
                selected ? "chip-accent" : "",
                disabled ? "opacity-50 cursor-not-allowed" : "",
              )}
              data-card-skip-open
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Legacy single-axis picker. Kept for callers that haven't migrated to the
 * fused {agent, model} shape yet (decision-approve forms; spec-import).
 * Operates on the claude-code model list only.
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-card-skip-open>
      {MODELS_BY_AGENT["claude-code"].map((opt) => {
        const selected = (value ?? null) === opt.id;
        return (
          <button
            key={opt.id ?? "default"}
            type="button"
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            title={opt.hint}
            className={cn(
              "chip mono cursor-pointer",
              selected ? "chip-accent" : "",
              disabled ? "opacity-50 cursor-not-allowed" : "",
            )}
            data-card-skip-open
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
