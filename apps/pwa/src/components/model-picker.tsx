import { cn } from "../lib/cn.ts";

export interface ModelOption {
  id: string | null;
  label: string;
  hint: string;
}

/**
 * The list of selectable models. Keep in sync with what `claude --model`
 * accepts. `null` lets the CLI pick its own default (typically Sonnet).
 */
export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: null, label: "default", hint: "claude cli's choice" },
  { id: "claude-opus-4-7", label: "opus 4.7", hint: "max capability" },
  { id: "claude-sonnet-4-6", label: "sonnet 4.6", hint: "balanced" },
  { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fast / cheap" },
];

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
      {MODEL_OPTIONS.map((opt) => {
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
