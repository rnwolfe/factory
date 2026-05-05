import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

export function PromptsViewer() {
  const list = useQuery({
    queryKey: ["prompts.list"],
    queryFn: () => trpc.prompts.list.query(),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">prompts</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · active
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        the active prompts the daemon serves to triage, plans, and audits. tap a row to view, edit,
        or roll back to a prior version.
      </p>

      {list.isLoading ? (
        <div className="surface p-3">
          <div className="skel h-4 w-1/2 mb-2" />
          <div className="skel h-3 w-3/4" />
        </div>
      ) : list.isError ? (
        <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
          failed to load prompts.
        </div>
      ) : list.data && list.data.length > 0 ? (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {list.data.map((p) => (
            <li key={p.id}>
              <Link
                to={`/settings/prompts/${encodeURIComponent(p.promptKey)}`}
                className="flex items-center justify-between gap-3 px-3 h-12 hover:bg-[var(--color-bg-2)]"
              >
                <span className="mono text-[12.5px] text-[var(--color-fg-1)] truncate">
                  {p.promptKey}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {p.lineCount} lines
                  </span>
                  <span className="mono text-[11px] text-[var(--color-fg-3)]">v{p.version}</span>
                  <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="surface p-3 text-[13px] text-[var(--color-fg-3)]">no active prompts.</div>
      )}
    </div>
  );
}
