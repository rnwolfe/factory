import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

export function RubricsViewer() {
  const list = useQuery({
    queryKey: ["rubrics.list"],
    queryFn: () => trpc.rubrics.list.query(),
  });

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">rubrics</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · active
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        the active rubrics the daemon uses to triage ideas. tap a row to view, edit, or roll back to
        a prior version.
      </p>

      {list.isLoading ? (
        <div className="surface p-3">
          <div className="skel h-4 w-1/2 mb-2" />
          <div className="skel h-3 w-3/4" />
        </div>
      ) : list.isError ? (
        <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
          failed to load rubrics.
        </div>
      ) : list.data && list.data.length > 0 ? (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {list.data.map((r) => (
            <li key={r.id}>
              <Link
                to={`/settings/rubrics/${encodeURIComponent(r.rubricKey)}`}
                className="flex items-center justify-between gap-3 px-3 h-12 hover:bg-[var(--color-bg-2)]"
              >
                <span className="mono text-[12.5px] text-[var(--color-fg-1)] truncate">
                  {r.rubricKey}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {r.lineCount} lines
                  </span>
                  <span className="mono text-[11px] text-[var(--color-fg-3)]">v{r.version}</span>
                  <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="surface p-3 text-[13px] text-[var(--color-fg-3)]">no active rubrics.</div>
      )}
    </div>
  );
}
