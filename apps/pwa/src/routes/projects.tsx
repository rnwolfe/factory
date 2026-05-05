import { useQuery } from "@tanstack/react-query";
import { FolderInput, Layers } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

const TAGS = ["active", "background", "past"] as const;

export function Projects() {
  const list = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
  });

  if (list.isLoading) return <ProjectsSkeleton />;

  const rows = list.data ?? [];
  if (rows.length === 0) {
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
      <Link to="/projects/import" className="btn btn-ghost w-full">
        <FolderInput size={14} /> import existing project
      </Link>
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
                      {p.slug} · {p.tier} · {p.goal}
                    </div>
                  </div>
                  <span className={`chip chip-${p.tag === "active" ? "accent" : ""}`}>{p.tag}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
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
