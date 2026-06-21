import { useQuery } from "@tanstack/react-query";
import { FolderInput, Layers, ListChecks } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

const TAGS = ["active", "background", "past"] as const;
const VISIBLE_TAGS = ["active", "background"] as const;

export function Projects() {
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: 10_000,
  });

  if (list.isLoading) return <ProjectsSkeleton />;

  const allRows = list.data ?? [];
  const rows = showArchived
    ? allRows
    : allRows.filter((r) => (VISIBLE_TAGS as readonly string[]).includes(r.tag));
  const archivedCount = allRows.filter((r) => r.tag === "past").length;

  if (rows.length === 0 && allRows.length === 0) {
    return (
      <div className="space-y-3">
        <div className="surface p-6 text-center">
          <Layers size={28} className="mx-auto text-[var(--color-fg-3)] mb-2" />
          <div className="display text-lg mb-1">no projects yet</div>
          <p className="text-sm text-[var(--color-fg-2)]">
            approve a greenlit decision to spawn one — or import an existing repo.
          </p>
        </div>
        <Link to="/projects/import" className="btn btn-primary w-full">
          <FolderInput size={14} /> import existing project
        </Link>
      </div>
    );
  }

  const grouped = TAGS.map((t) => ({
    tag: t,
    rows: rows.filter((r) => r.tag === t),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <Link to="/tasks" className="btn btn-ghost flex-1">
          <ListChecks size={14} /> open tasks
        </Link>
        <Link to="/projects/import" className="btn btn-ghost flex-1">
          <FolderInput size={14} /> import project
        </Link>
      </div>
      {archivedCount > 0 ? (
        <label className="flex items-center justify-end gap-1.5 text-[11.5px] text-[var(--color-fg-2)] cursor-pointer px-1">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>show archived ({archivedCount})</span>
        </label>
      ) : null}
      {grouped.map((g) => (
        <section key={g.tag}>
          <div className="flex items-center gap-2 px-1 mb-1.5">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              {g.tag}
            </span>
            <div className="hairline flex-1" />
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{g.rows.length}</span>
          </div>
          <div className="surface divide-y divide-[var(--color-line)]">
            {g.rows.map((p) => (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)] active:bg-[var(--color-bg-3)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] text-[var(--color-fg)] truncate">{p.name}</div>
                    <div className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                      {p.slug} · {p.ceremony} · {p.role}
                      {p.license ? ` · ${p.license}` : ""}
                    </div>
                  </div>
                  <ActivityChip running={p.runningRunCount ?? 0} queued={p.queuedRunCount ?? 0} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ActivityChip({ running, queued }: { running: number; queued: number }) {
  // Runtime activity, not the operator-set workflow tag (which is already the
  // section header — repeating it on each row is what the operator flagged as
  // not meaningful). Running outranks queued; we only show one chip per row
  // to keep the right edge readable on a 390px viewport.
  if (running > 0) {
    return (
      <span className="chip chip-accent" title={`${running} running, ${queued} queued`}>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] mr-1 animate-pulse"
          aria-hidden="true"
        />
        running{running > 1 ? ` ${running}` : ""}
      </span>
    );
  }
  if (queued > 0) {
    return <span className="chip">queued{queued > 1 ? ` ${queued}` : ""}</span>;
  }
  return <span className="mono text-[10.5px] text-[var(--color-fg-3)]">idle</span>;
}

function ProjectsSkeleton() {
  const slots = ["s1", "s2", "s3", "s4", "s5"] as const;
  return (
    <div className="space-y-2.5">
      {slots.map((id) => (
        <div key={id} className="surface px-3 py-2.5">
          <div className="skel h-4 w-2/3 mb-1.5" />
          <div className="skel h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
