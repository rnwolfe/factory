import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface RunRow {
  id: string;
  status: string;
  taskId: string | null;
  startedAt: number;
}

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function TaskDetail() {
  const { id = "", taskId = "" } = useParams<{ id: string; taskId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const task = useQuery({
    queryKey: ["projects.tasks.get", id, taskId],
    queryFn: () => trpc.projects.tasks.get.query({ projectId: id, taskId }),
    enabled: id.length > 0 && taskId.length > 0,
    refetchInterval: 4_000,
  });

  const runs = useQuery({
    queryKey: ["runs.list", id],
    queryFn: () => trpc.runs.list.query({ projectId: id }) as unknown as Promise<RunRow[]>,
    enabled: id.length > 0,
    refetchInterval: 4_000,
  });

  const taskRuns = (runs.data ?? []).filter((r) => r.taskId === taskId);
  const activeRun = taskRuns.find((r) => ACTIVE_STATUSES.has(r.status));

  const start = useMutation({
    mutationFn: () => trpc.runs.start.mutate({ projectId: id, taskId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["runs.list", id] });
      nav(`/projects/${id}/runs/${res.runId}`);
    },
  });

  const updateBody = useMutation({
    mutationFn: (body: string) =>
      trpc.projects.tasks.updateBody.mutate({ projectId: id, taskId, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.tasks.get", id, taskId] });
    },
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!editing && task.data) {
      setDraft(task.data.body);
    }
  }, [editing, task.data]);

  if (task.isLoading) return <TaskSkeleton />;
  if (!task.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        task not found.{" "}
        <Link to={`/projects/${id}`} className="text-[var(--color-accent)] underline">
          back
        </Link>
      </div>
    );
  }

  const fm = task.data.frontmatter;
  const isDone = fm.status === "done";

  return (
    <div className="space-y-4">
      <header className="surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to={`/projects/${id}`}
              className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] mb-2"
            >
              <ArrowLeft size={11} /> project
            </Link>
            <h1 className="display text-[20px] leading-tight text-[var(--color-fg)]">{fm.title}</h1>
            <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 flex items-center gap-2 flex-wrap">
              <span>{fm.id}</span>
              {fm.estimate ? <span>· {String(fm.estimate)}</span> : null}
              {fm.priority ? <span>· {String(fm.priority)}</span> : null}
            </div>
          </div>
          <span className={`chip status-${fm.status}`}>{fm.status}</span>
        </div>

        {activeRun ? (
          <Link to={`/projects/${id}/runs/${activeRun.id}`} className="btn btn-primary w-full mt-4">
            <Play size={14} />
            view active run · {activeRun.id.slice(0, 8)}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending || isDone}
            className="btn btn-primary w-full mt-4"
            title={
              isDone ? "task already done — start a follow-up from the project page" : undefined
            }
          >
            <Play size={14} />
            {start.isPending ? "starting…" : isDone ? "task done" : `run task · ${fm.id}`}
          </button>
        )}
        {start.isError ? (
          <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
            {(start.error as Error).message}
          </div>
        ) : null}
      </header>

      <section>
        <div className="flex items-center gap-2 px-1 mb-1.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            spec
          </span>
          <div className="hairline flex-1" />
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(task.data?.body ?? "");
                }}
                className="btn btn-ghost text-[11px] !h-7 !px-2"
                disabled={updateBody.isPending}
              >
                <X size={11} />
                cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  updateBody.mutate(draft, {
                    onSuccess: () => setEditing(false),
                  });
                }}
                className="btn btn-primary text-[11px] !h-7 !px-2"
                disabled={updateBody.isPending || draft === task.data?.body}
              >
                {updateBody.isPending ? "saving…" : "save"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              <Pencil size={11} />
              edit
            </button>
          )}
        </div>
        <div className="surface p-3">
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full min-h-[280px] bg-transparent text-[13px] text-[var(--color-fg-1)] mono leading-relaxed outline-none resize-y"
              spellCheck={false}
              disabled={updateBody.isPending}
            />
          ) : task.data.body.trim().length > 0 ? (
            <pre className="whitespace-pre-wrap break-words text-[13px] text-[var(--color-fg-1)] mono leading-relaxed">
              {task.data.body}
            </pre>
          ) : (
            <div className="text-[13px] text-[var(--color-fg-3)]">
              no body yet — edit to add acceptance criteria, context, etc.
            </div>
          )}
          {updateBody.isError ? (
            <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
              {(updateBody.error as Error).message}
            </div>
          ) : null}
        </div>
        <div className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1.5 px-1">
          edits to this spec apply to future runs of this task.
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 px-1 mb-1.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            runs
          </span>
          <div className="hairline flex-1" />
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{taskRuns.length}</span>
        </div>
        <div className="surface divide-y divide-[var(--color-line)]">
          {taskRuns.length === 0 ? (
            <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">
              no runs targeted this task yet.
            </div>
          ) : (
            taskRuns.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${id}/runs/${r.id}`}
                className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <RunStatusChip status={r.status} />
                    <span className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                      {r.id.slice(0, 8)}
                    </span>
                  </div>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {timeAgo(r.startedAt)}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function RunStatusChip({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "chip-greenlit"
      : status === "running" || status === "queued"
        ? "chip-accent"
        : status === "failed" || status === "aborted" || status === "blocked"
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

function TaskSkeleton() {
  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="skel h-3 w-1/4 mb-2" />
        <div className="skel h-6 w-2/3 mb-2" />
        <div className="skel h-3 w-1/3" />
      </div>
      <div className="surface px-3 py-2.5">
        <div className="skel h-4 w-2/3 mb-1.5" />
        <div className="skel h-3 w-1/2" />
      </div>
    </div>
  );
}
