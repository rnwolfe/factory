import { useMutation } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import type { AuditFinding } from "./audit-card.tsx";

interface Props {
  auditId: string;
  findings: AuditFinding[];
  onClose: () => void;
  onPromoted: (result: {
    recommendation: "plan" | "bug";
    planId?: string;
    taskId?: string;
  }) => void;
}

export function PromoteFindingsModal({ auditId, findings, onClose, onPromoted }: Props) {
  const [error, setError] = useState<string | null>(null);
  const promote = useMutation({
    mutationFn: () =>
      trpc.audits.promoteFindings.mutate({
        auditId,
        findingIds: findings.map((f) => f.id),
      }),
    onSuccess: (data) => {
      onPromoted({
        recommendation: data.recommendation as "plan" | "bug",
        planId: data.planId,
        taskId: data.taskId,
      });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 px-3 pb-3 pt-12">
      <div className="surface w-full max-w-md max-h-full flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
          <span className="display text-[15px] text-[var(--color-fg)]">promote findings</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            ({findings.length} selected)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-3 overflow-y-auto flex-1 space-y-2">
          <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
            The agent will read these findings and recommend either a draft plan (heavyweight:
            iterate then freeze) or a bug task (lightweight: captured for later refinement). You can
            override the recommendation.
          </div>
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li
                key={f.id}
                className="px-2.5 py-1.5 rounded-sm bg-[var(--color-bg-2)] text-[12.5px]"
              >
                <span className="mono text-[10.5px] text-[var(--color-fg-3)] uppercase mr-2">
                  {f.severity}
                </span>
                {f.title}
              </li>
            ))}
          </ul>
          {error ? (
            <div className="text-[12.5px] text-[var(--color-verdict-trashed)] mono leading-relaxed">
              {error}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-[var(--color-line)] flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost mono text-[11px]"
            onClick={onClose}
            disabled={promote.isPending}
          >
            cancel
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => promote.mutate()}
            disabled={promote.isPending || findings.length === 0}
          >
            {promote.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> evaluating…
              </>
            ) : (
              "evaluate & route"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
