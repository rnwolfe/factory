import { useMutation } from "@tanstack/react-query";
import { Loader2, Rocket, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface Props {
  projectId: string;
}

export function FeaturePlanLaunch({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const nav = useNavigate();

  const start = useMutation({
    mutationFn: (g: string) => trpc.plans.startFeaturePlan.mutate({ projectId, goal: g.trim() }),
    onSuccess: (data) => {
      setOpen(false);
      setGoal("");
      nav(`/plans/${data.planId}`);
    },
  });

  return (
    <>
      <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setOpen(true)}>
        <Rocket size={12} /> ship feature
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 px-3 pb-3 pt-12">
          <div className="surface w-full max-w-md flex flex-col">
            <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
              <span className="display text-[15px]">ship feature</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-auto text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                Name the feature you want to ship. The agent will draft a feature_plan you iterate
                on, then freeze emits the planned tasks into the project.
              </div>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
                placeholder="e.g. add export-to-markdown command"
                className="surface w-full bg-[var(--color-bg-2)] px-3 py-2 text-[13px] text-[var(--color-fg)] resize-none"
              />
              {start.isError ? (
                <div className="mono text-[11px] text-[var(--color-verdict-trashed)]">
                  {(start.error as Error).message}
                </div>
              ) : null}
            </div>
            <div className="px-4 py-3 border-t border-[var(--color-line)] flex items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost mono text-[11px]"
                onClick={() => setOpen(false)}
              >
                cancel
              </button>
              <div className="flex-1" />
              <button
                type="button"
                className="btn btn-primary"
                disabled={start.isPending || goal.trim().length === 0}
                onClick={() => start.mutate(goal)}
              >
                {start.isPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> starting…
                  </>
                ) : (
                  "start plan"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
