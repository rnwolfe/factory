import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type Tag, TagChip } from "../components/tag-chip.tsx";
import { trpc } from "../lib/trpc.ts";

export function ProjectDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: ["projects.get", id],
    queryFn: () => trpc.projects.get.query({ id }),
    enabled: id.length > 0,
  });

  const runs = useQuery({
    queryKey: ["runs.list", id],
    queryFn: () => trpc.runs.list.query({ projectId: id }),
    enabled: id.length > 0,
    refetchInterval: 4_000,
  });

  const start = useMutation({
    mutationFn: (vars: { taskId?: string }) =>
      trpc.runs.start.mutate({ projectId: id, taskId: vars.taskId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["runs.list", id] });
      nav(`/projects/${id}/runs/${res.runId}`);
    },
  });

  if (project.isLoading) return <ProjectSkeleton />;
  if (!project.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        project not found.{" "}
        <Link to="/projects" className="text-[var(--color-accent)] underline">
          back
        </Link>
      </div>
    );
  }

  const { project: p, tasks } = project.data;
  const readyTasks = tasks.filter((t) => t.status === "ready");
  const nextTask = readyTasks[0];

  return (
    <div className="space-y-4">
      <header className="surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/projects"
              className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] mb-2"
            >
              <ArrowLeft size={11} /> projects
            </Link>
            <h1 className="display text-[22px] leading-tight text-[var(--color-fg)] truncate">
              {p.name}
            </h1>
            <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 truncate">
              {p.slug} · {p.tier} · goal {p.goal}
            </div>
          </div>
          <TagChip projectId={p.id} tag={p.tag as Tag} />
        </div>

        <button
          type="button"
          onClick={() => start.mutate({ taskId: nextTask?.id })}
          disabled={start.isPending}
          className="btn btn-primary w-full mt-4"
        >
          <Play size={14} />
          {start.isPending
            ? "starting…"
            : nextTask
              ? `start run · ${nextTask.id}`
              : "start ad-hoc run"}
        </button>
        {start.isError ? (
          <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
            {(start.error as Error).message}
          </div>
        ) : null}
      </header>

      <section>
        <SectionHeader title="tasks" count={tasks.length} />
        <div className="surface divide-y divide-[var(--color-line)]">
          {tasks.length === 0 ? (
            <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">
              no tasks yet — first run will create them.
            </div>
          ) : (
            tasks.map((t) => (
              <div key={t.id} className="px-3 py-2.5 flex items-center gap-3">
                <span className={`chip status-${t.status}`}>{t.status}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">{t.title}</div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {t.id} · {String(t.estimate ?? "—")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => start.mutate({ taskId: t.id })}
                  disabled={start.isPending || t.status === "done"}
                  className="btn btn-ghost text-[11px] !h-8 !px-2"
                  aria-label="run this task"
                >
                  <Play size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <SectionHeader title="runs" count={runs.data?.length ?? 0} />
        <div className="surface divide-y divide-[var(--color-line)]">
          {runs.isLoading ? (
            <div className="px-3 py-4">
              <div className="skel h-4 w-2/3 mb-1" />
              <div className="skel h-3 w-1/3" />
            </div>
          ) : runs.data && runs.data.length > 0 ? (
            runs.data.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${id}/runs/${r.id}`}
                className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <RunStatusChip status={r.status} />
                    <span className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                      {r.id.slice(0, 8)} · {r.taskId ?? "ad-hoc"}
                    </span>
                  </div>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {timeAgo(r.startedAt)}
                  </span>
                </div>
              </Link>
            ))
          ) : (
            <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">no runs yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
      <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{count}</span>
    </div>
  );
}

function RunStatusChip({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "chip-greenlit"
      : status === "running"
        ? "chip-accent"
        : status === "failed" || status === "aborted"
          ? "chip-trashed"
          : "";
  return <span className={`chip ${tone}`}>{status}</span>;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ProjectSkeleton() {
  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="skel h-5 w-1/3 mb-2" />
        <div className="skel h-7 w-2/3 mb-2" />
        <div className="skel h-3 w-1/2" />
      </div>
      <div className="surface px-3 py-2.5">
        <div className="skel h-4 w-2/3 mb-1.5" />
        <div className="skel h-3 w-1/3" />
      </div>
    </div>
  );
}
