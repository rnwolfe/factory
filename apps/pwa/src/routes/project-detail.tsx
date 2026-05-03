import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Folder, GitBranch, Play } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ModelPicker } from "../components/model-picker.tsx";
import { type Tag, TagChip } from "../components/tag-chip.tsx";
import { trpc } from "../lib/trpc.ts";

interface WorkdirSnapshot {
  exists: boolean;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  status: Array<{ code: string; path: string }>;
  commits: Array<{ sha: string; subject: string; ts: number; author: string }>;
  worktrees: Array<{ path: string; branch: string | null; head: string | null }>;
  tree: Array<{ path: string; type: "file" | "dir"; size: number | null }>;
}

export function ProjectDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: ["projects.get", id],
    queryFn: () => trpc.projects.get.query({ id }),
    enabled: id.length > 0,
    refetchInterval: 4_000,
  });

  const runs = useQuery({
    queryKey: ["runs.list", id],
    queryFn: () => trpc.runs.list.query({ projectId: id }),
    enabled: id.length > 0,
    refetchInterval: 4_000,
  });

  const workdir = useQuery({
    queryKey: ["projects.workdir", id],
    queryFn: () => trpc.projects.workdir.query({ id }) as unknown as Promise<WorkdirSnapshot>,
    enabled: id.length > 0,
    refetchInterval: 8_000,
  });

  const start = useMutation({
    mutationFn: (vars: { taskId?: string }) =>
      trpc.runs.start.mutate({ projectId: id, taskId: vars.taskId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["runs.list", id] });
      nav(`/projects/${id}/runs/${res.runId}`);
    },
  });

  const setAutoAdvance = useMutation({
    mutationFn: (autoAdvance: boolean) => trpc.projects.setAutoAdvance.mutate({ id, autoAdvance }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", id] });
    },
  });

  const setModel = useMutation({
    mutationFn: (model: string | null) => trpc.projects.setModel.mutate({ id, model }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", id] });
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

        <label className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--color-fg-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={p.autoAdvance ?? true}
            onChange={(e) => setAutoAdvance.mutate(e.target.checked)}
            disabled={setAutoAdvance.isPending}
            className="accent-[var(--color-accent)]"
          />
          <span>auto-advance to next ready task on success</span>
        </label>

        <div className="mt-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            model
          </div>
          <ModelPicker
            value={p.model ?? null}
            onChange={(m) => setModel.mutate(m)}
            disabled={setModel.isPending}
          />
        </div>
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
        <SectionHeader
          title="workdir"
          count={
            workdir.data?.exists
              ? (workdir.data.status.length ?? 0) + (workdir.data.tree.length ?? 0)
              : 0
          }
        />
        <WorkdirPanel data={workdir.data} loading={workdir.isLoading} />
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

function WorkdirPanel({
  data,
  loading,
}: {
  data: WorkdirSnapshot | null | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="surface px-3 py-3">
        <div className="skel h-3 w-1/3 mb-2" />
        <div className="skel h-3 w-2/3 mb-1.5" />
        <div className="skel h-3 w-1/2" />
      </div>
    );
  }
  if (!data?.exists) {
    return (
      <div className="surface px-3 py-4 text-[13px] text-[var(--color-fg-3)]">
        workdir not found on disk.
      </div>
    );
  }
  const { branch, headSha, dirty, status, commits, worktrees, tree } = data;
  return (
    <div className="surface divide-y divide-[var(--color-line)]">
      <div className="px-3 py-2.5 flex items-center gap-2 flex-wrap">
        <GitBranch size={12} className="text-[var(--color-fg-3)]" />
        <span className="mono text-[12px] text-[var(--color-fg-1)] truncate">
          {branch ?? "(detached)"}
        </span>
        {headSha ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{headSha.slice(0, 8)}</span>
        ) : null}
        <span
          className={`chip ${dirty ? "chip-trashed" : "chip-greenlit"} ml-auto`}
          title={dirty ? `${status.length} change(s)` : "clean"}
        >
          {dirty ? `dirty · ${status.length}` : "clean"}
        </span>
      </div>

      {dirty ? (
        <div className="px-3 py-2.5">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            git status
          </div>
          <ul className="space-y-0.5 max-h-[140px] overflow-y-auto">
            {status.slice(0, 80).map((s) => (
              <li
                key={`${s.code}-${s.path}`}
                className="mono text-[11.5px] flex gap-2 leading-snug"
              >
                <span className="text-[var(--color-accent)] w-6 shrink-0">{s.code.trim()}</span>
                <span className="text-[var(--color-fg-1)] truncate">{s.path}</span>
              </li>
            ))}
            {status.length > 80 ? (
              <li className="mono text-[10.5px] text-[var(--color-fg-3)]">
                +{status.length - 80} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {commits.length > 0 ? (
        <div className="px-3 py-2.5">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            recent commits
          </div>
          <ul className="space-y-1">
            {commits.slice(0, 10).map((c) => (
              <li key={c.sha} className="text-[12.5px] leading-snug">
                <span className="mono text-[11px] text-[var(--color-accent)] mr-2">
                  {c.sha.slice(0, 8)}
                </span>
                <span className="text-[var(--color-fg-1)]">{c.subject}</span>
                <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-2">{c.author}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {worktrees.length > 1 ? (
        <div className="px-3 py-2.5">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            worktrees
          </div>
          <ul className="space-y-0.5">
            {worktrees.map((w) => (
              <li key={w.path} className="mono text-[11.5px] truncate">
                <span className="text-[var(--color-accent)] mr-2">{w.branch ?? "(detached)"}</span>
                <span className="text-[var(--color-fg-3)]">{w.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tree.length > 0 ? (
        <div className="px-3 py-2.5">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            tree
          </div>
          <ul className="space-y-0.5">
            {tree.map((entry) => (
              <li key={entry.path} className="mono text-[12px] flex items-center gap-2">
                {entry.type === "dir" ? (
                  <Folder size={11} className="text-[var(--color-accent)] shrink-0" />
                ) : (
                  <FileText size={11} className="text-[var(--color-fg-3)] shrink-0" />
                )}
                <span className="text-[var(--color-fg-1)] truncate">
                  {entry.path}
                  {entry.type === "dir" ? "/" : ""}
                </span>
                {entry.size != null ? (
                  <span className="text-[var(--color-fg-3)] ml-auto tabular-nums">
                    {fmtSize(entry.size)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
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
