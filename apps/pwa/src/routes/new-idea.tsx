import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

const GOALS = ["me", "learn", "share", "productize"] as const;
type Goal = (typeof GOALS)[number] | "";

export function NewIdea() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [goal, setGoal] = useState<Goal>("");

  const submit = useMutation({
    mutationFn: (vars: { rawText: string; goalHint?: Goal }) =>
      trpc.ideas.create.mutate({
        rawText: vars.rawText,
        goalHint:
          vars.goalHint && (vars.goalHint as string).length > 0
            ? (vars.goalHint as Exclude<Goal, "">)
            : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["ideas.list"] });
      nav("/");
    },
  });

  const can = text.trim().length > 0 && !submit.isPending;

  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <label
          htmlFor="idea-text"
          className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2"
        >
          idea
        </label>
        <textarea
          id="idea-text"
          // biome-ignore lint/a11y/noAutofocus: single-purpose capture screen
          autoFocus
          className="textarea"
          placeholder="what's on your mind? a sentence is enough."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="mt-4 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          goal hint (optional)
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {GOALS.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGoal(goal === g ? "" : g)}
              className={
                goal === g ? "chip chip-accent" : "chip hover:border-[var(--color-line-bright)]"
              }
            >
              {g}
            </button>
          ))}
        </div>

        {submit.isError ? (
          <div className="mt-3 text-xs text-[var(--color-verdict-trashed)]">
            {(submit.error as Error).message}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary w-full mt-5"
          disabled={!can}
          onClick={() => submit.mutate({ rawText: text, goalHint: goal })}
        >
          {submit.isPending ? "submitting…" : "submit & triage"}
          {!submit.isPending && <ArrowRight size={16} />}
        </button>
      </div>

      <p className="text-[12px] mono text-[var(--color-fg-3)] px-2">
        the factory will triage this against the active rubric within ~2 min and surface a decision
        card.
      </p>
    </div>
  );
}
