import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListChecks } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

/**
 * Cross-project open-tasks view — a read-only bird's-eye of every project's
 * incomplete/stalled tasks, grouped by project. Backs feature plan w81q7q32.
 * The daemon's `projects.crossProjectOpenTasks` query already does the
 * aggregation (open = status not done/dropped, zero-open projects omitted),
 * so this route is purely presentational: group header + count + link-back
 * to each task's detail. No mutations, no run affordance — this is a triage
 * surface, not a control surface.
 */
export function OpenTasks() {
  const tasks = useQuery({
    queryKey: ["projects.crossProjectOpenTasks"],
    queryFn: () => trpc.projects.crossProjectOpenTasks.query(),
    refetchInterval: 10_000,
  });

  if (tasks.isLoading) return <OpenTasksSkeleton />;

  const groups = tasks.data ?? [];
  const totalOpen = groups.reduce((sum, g) => sum + g.tasks.length, 0);

  if (groups.length === 0) {
    return (
      <div className="surface p-6 text-center">
        <ListChecks size={28} className="mx-auto text-[var(--color-fg-3)] mb-2" />
        <div className="display text-lg mb-1">no open tasks</div>
        <p className="text-sm text-[var(--color-fg-2)]">
          every project's queue is clear — nothing ready, in progress, in review, or blocked.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-2 px-1">
        <span className="display text-lg text-[var(--color-fg)]">open tasks</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          {totalOpen} across {groups.length} project{groups.length === 1 ? "" : "s"}
        </span>
      </div>

      {groups.map((g) => (
        <section key={g.project.id}>
          <div className="flex items-center gap-2 px-1 mb-1.5">
            <Link
              to={`/projects/${g.project.id}`}
              className="text-[13px] text-[var(--color-fg-1)] hover:text-[var(--color-accent)] truncate"
            >
              {g.project.name}
            </Link>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
              {g.project.slug}
            </span>
            <div className="hairline flex-1" />
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{g.tasks.length}</span>
          </div>
          <div className="surface divide-y divide-[var(--color-line)]">
            {g.tasks.map((t) => (
              <Link
                key={t.id}
                to={`/projects/${g.project.id}/tasks/${t.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)] active:bg-[var(--color-bg-3)]"
              >
                <span className={`chip status-${t.status} shrink-0`}>{t.status}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-[var(--color-fg)] truncate">{t.title}</div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {t.id}
                    {t.priority ? ` · ${t.priority}` : ""}
                    {t.estimate ? ` · ${t.estimate}` : ""}
                  </div>
                </div>
                <ChevronRight size={14} className="text-[var(--color-fg-3)] shrink-0" />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function OpenTasksSkeleton() {
  const slots = ["s1", "s2", "s3"] as const;
  return (
    <div className="space-y-5">
      {slots.map((id) => (
        <section key={id}>
          <div className="skel h-3 w-1/3 mb-1.5" />
          <div className="surface px-3 py-2.5 space-y-2">
            <div className="skel h-4 w-2/3" />
            <div className="skel h-4 w-1/2" />
          </div>
        </section>
      ))}
    </div>
  );
}
