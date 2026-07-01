import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

export type AgentName = "claude-code" | "codex";

export interface ModelOption {
  id: string | null;
  label: string;
  hint: string;
}

interface AgentDescriptorView {
  id: string;
  label: string;
  hint: string;
  models: ReadonlyArray<ModelOption>;
  supports: { resume: boolean; interactiveSession: boolean };
}

/**
 * Fallback model lineup used only when the `agents.list` tRPC query hasn't
 * resolved yet (or fails). The authoritative source is the daemon's
 * `apps/daemon/src/agents/registry.ts` — the picker reads from there via
 * `trpc.agents.list`, so adding a new harness or refreshing a model id is a
 * single registry-entry edit on the daemon with no PWA changes needed.
 *
 * Keeping a static fallback so an offline daemon doesn't strand the picker
 * with empty chips.
 */
const FALLBACK_AGENTS: ReadonlyArray<AgentDescriptorView> = [
  {
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
  },
  {
    id: "codex",
    label: "codex",
    hint: "openai codex (chatgpt subscription)",
    models: [{ id: null, label: "default", hint: "codex cli's choice" }],
    supports: { resume: false, interactiveSession: true },
  },
];

/**
 * Subscribe to the registry-served descriptor list. Cached for ~5min so
 * unrelated re-renders don't re-fetch. Exported for callers that need the
 * raw agent list outside of the fused picker (e.g. retry-agent chip rows on
 * the decision-detail page).
 */
export function useAgentRegistry(): ReadonlyArray<AgentDescriptorView> {
  const q = useQuery({
    queryKey: ["agents.list"],
    queryFn: () => trpc.agents.list.query() as Promise<ReadonlyArray<AgentDescriptorView>>,
    staleTime: 5 * 60 * 1000,
  });
  return q.data ?? FALLBACK_AGENTS;
}

/** Back-compat: pre-fused-picker callers that still import this constant. */
export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = FALLBACK_AGENTS[0]?.models ?? [];

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
  const agents = useAgentRegistry();
  const effectiveAgent: string = agent ?? "claude-code";
  const effective = agents.find((a) => a.id === effectiveAgent) ?? agents[0];
  const models = effective?.models ?? [];
  return (
    <div className="space-y-2" data-card-skip-open>
      <div className="flex flex-wrap gap-1.5">
        {agents.map((opt) => {
          const selected = effectiveAgent === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                if (opt.id === effectiveAgent) return;
                onAgentChange(opt.id as AgentName);
                onModelChange(null);
              }}
              disabled={disabled}
              title={opt.hint}
              className={cn(
                "chip mono cursor-pointer",
                selected ? "chip-working" : "",
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
                selected ? "chip-working" : "",
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
 * Operates on the claude-code model list only, queried from the registry
 * with the static fallback for offline / pre-resolve states.
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
  const agents = useAgentRegistry();
  const claude = agents.find((a) => a.id === "claude-code");
  const models = claude?.models ?? MODEL_OPTIONS;
  return (
    <div className="flex flex-wrap gap-1.5" data-card-skip-open>
      {models.map((opt) => {
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
              selected ? "chip-working" : "",
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
