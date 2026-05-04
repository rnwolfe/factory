import { cn } from "../lib/cn.ts";

export type PlanKind = "project_spec" | "task_plan" | "refinement" | "feature_plan";
export type PlanStatus = "drafting" | "frozen" | "abandoned";

export interface PlanRow {
  id: string;
  kind: PlanKind;
  status: PlanStatus;
  decisionId: string | null;
  projectId: string | null;
  taskId: string | null;
  goal: string;
  draft: string;
  createdAt: number;
  updatedAt: number;
  frozenAt?: number | null;
  abandonedAt?: number | null;
}

export interface PlanThreadHint {
  /** Latest agent comment body, truncated by the caller. Null when none yet. */
  latestAgentReply: string | null;
  /** True when the most-recent comment is operator (i.e., the agent is thinking). */
  awaitingAgent: boolean;
}

interface Props {
  plan: PlanRow;
  hint?: PlanThreadHint | null;
  index?: number;
  onOpen: () => void;
}

function kindLabel(kind: PlanKind): string {
  switch (kind) {
    case "project_spec":
      return "project spec";
    case "task_plan":
      return "task plan";
    case "refinement":
      return "refinement";
    case "feature_plan":
      return "feature plan";
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function PlanCard({ plan, hint, index = 0, onOpen }: Props) {
  return (
    <div
      className="surface drop-in border-l-2 border-[var(--color-verdict-decompose,_var(--color-accent))]"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <button type="button" onClick={onOpen} className="w-full text-left">
        <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
          <span className={cn("chip", "chip-decompose")}>{kindLabel(plan.kind)}</span>
          <span className="chip">{plan.status}</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            · {timeAgo(plan.updatedAt || plan.createdAt)} ago
          </span>
        </div>
        <div className="px-4 pb-3">
          <div className="display text-[17px] leading-snug text-[var(--color-fg)] line-clamp-2">
            {plan.goal || "(unnamed plan)"}
          </div>
          {hint?.latestAgentReply ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-2)] line-clamp-2">
              {hint.latestAgentReply}
            </p>
          ) : hint?.awaitingAgent ? (
            <div className="mt-2 flex items-center gap-1">
              <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mr-1">
                agent · thinking
              </span>
              <span className="skel h-2 w-2 rounded-full" />
              <span className="skel h-2 w-2 rounded-full" />
              <span className="skel h-2 w-2 rounded-full" />
            </div>
          ) : (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-3)]">
              tap to iterate with the agent and freeze when ready.
            </p>
          )}
        </div>
      </button>
    </div>
  );
}
