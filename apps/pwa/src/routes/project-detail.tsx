import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  GitBranch,
  ListTree,
  Play,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AuditsSection } from "../components/audits-section.tsx";
import { type Ceremony, CeremonyPicker } from "../components/ceremony-picker.tsx";
import { FeaturePlanLaunch } from "../components/feature-plan-launch.tsx";
import { ProjectMetricsChip } from "../components/metrics-chip.tsx";
import { ModelPicker } from "../components/model-picker.tsx";
import type { PlanRow } from "../components/plan-card.tsx";
import { ProjectOverflowMenu } from "../components/project-overflow-menu.tsx";
import { PublishGithubModal } from "../components/publish-github-modal.tsx";
import { type ProjectRole, RolePicker } from "../components/role-picker.tsx";
import { ScriptsSection } from "../components/scripts-section.tsx";
import { SessionsList } from "../components/sessions-list.tsx";
import { type Tag, TagChip } from "../components/tag-chip.tsx";
import { useProjectChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";

interface RunRow {
  id: string;
  status: string;
  taskId: string | null;
  startedAt: number;
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

function githubHtmlUrlFromClone(cloneUrl: string): string {
  // GitHub HTTPS clone URLs are `https://github.com/<owner>/<name>.git`.
  return cloneUrl.replace(/\.git$/, "");
}

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
  const [showPublish, setShowPublish] = useState(false);

  const project = useQuery({
    queryKey: ["projects.get", id],
    queryFn: () => trpc.projects.get.query({ id }),
    enabled: id.length > 0,
    refetchInterval: 30_000,
  });

  const githubTokenStatus = useQuery({
    queryKey: ["projects.hasGithubToken"],
    queryFn: () => trpc.projects.hasGithubToken.query() as unknown as Promise<{ has: boolean }>,
    staleTime: 60_000,
  });

  const runs = useQuery({
    queryKey: ["runs.list", id],
    queryFn: () => trpc.runs.list.query({ projectId: id }) as unknown as Promise<RunRow[]>,
    enabled: id.length > 0,
    refetchInterval: 30_000,
  });

  const runIds = (runs.data ?? []).map((r) => r.id);
  const runMetrics = useQuery({
    queryKey: ["metrics.forOwners.run", id, runIds.length],
    queryFn: () =>
      trpc.metrics.forOwners.query({
        ownerKind: "run",
        ownerIds: runIds,
      }) as unknown as Promise<
        Record<
          string,
          {
            totalCostUsd: number;
            inputTokens: number;
            outputTokens: number;
            durationMs: number;
            invocations: number;
          }
        >
      >,
    enabled: runIds.length > 0,
    staleTime: 30_000,
  });

  const workdir = useQuery({
    queryKey: ["projects.workdir", id],
    queryFn: () => trpc.projects.workdir.query({ id }) as unknown as Promise<WorkdirSnapshot>,
    enabled: id.length > 0,
    refetchInterval: 30_000,
  });

  const projectPlans = useQuery({
    queryKey: ["plans.list", id],
    queryFn: () => trpc.plans.list.query({ projectId: id }) as unknown as Promise<PlanRow[]>,
    enabled: id.length > 0,
    refetchInterval: 30_000,
  });

  // Live updates pushed via /ws/events?scope=project:<id>. The slow polling
  // above is a safety net for missed events / WS reconnect windows.
  useProjectChannel(id || null, [
    ["projects.get", id],
    ["runs.list", id],
    ["projects.workdir", id],
    ["plans.list", id],
    ["audits.list", id],
  ]);

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

  const { project: p, tasks } = project.data as unknown as {
    project: {
      id: string;
      slug: string;
      name: string;
      ceremony: string;
      role: string;
      license: string | null;
      tag: string;
      autoAdvance: boolean;
      model: string | null;
      githubRemote: string | null;
    };
    tasks: Array<{ id: string; status: string; title: string; estimate: string | null }>;
  };
  const allRuns = runs.data ?? [];
  const activeRuns = allRuns.filter((r) => ACTIVE_RUN_STATUSES.has(r.status));
  const activeRunByTask = new Map<string, RunRow>();
  for (const r of activeRuns) {
    if (r.taskId && !activeRunByTask.has(r.taskId)) activeRunByTask.set(r.taskId, r);
  }
  const headerActiveRun = activeRuns[0] ?? null;
  const nextStartableTask = tasks.find((t) => t.status === "ready" && !activeRunByTask.has(t.id));

  return (
    <div className="space-y-4">
      {showPublish ? (
        <PublishGithubModal
          projectId={p.id}
          defaultName={p.slug}
          onClose={() => setShowPublish(false)}
          onPublished={() => setShowPublish(false)}
        />
      ) : null}
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
            <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 flex items-center gap-2 flex-wrap">
              <span>{p.slug}</span>
              <span>·</span>
              <CeremonyPicker projectId={p.id} ceremony={p.ceremony as Ceremony} />
              <span>·</span>
              <RolePicker projectId={p.id} role={p.role as ProjectRole} />
              {p.license ? (
                <>
                  <span>·</span>
                  <span>{p.license}</span>
                </>
              ) : null}
              <ProjectMetricsChip
                projectId={p.id}
                className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] before:content-['·'] before:mr-2"
              />
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <TagChip projectId={p.id} tag={p.tag as Tag} />
            <ProjectOverflowMenu projectId={p.id} archived={p.tag === "past"} />
          </div>
        </div>

        {headerActiveRun ? (
          <Link
            to={`/projects/${id}/runs/${headerActiveRun.id}`}
            className="btn btn-primary w-full mt-4"
          >
            <Eye size={14} />
            view active run · {headerActiveRun.taskId ?? "ad-hoc"}
            {activeRuns.length > 1 ? ` (+${activeRuns.length - 1})` : ""}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => start.mutate({ taskId: nextStartableTask?.id })}
            disabled={start.isPending}
            className="btn btn-primary w-full mt-4"
          >
            <Play size={14} />
            {start.isPending
              ? "starting…"
              : nextStartableTask
                ? `start run · ${nextStartableTask.id}`
                : "start ad-hoc run"}
          </button>
        )}
        {start.isError ? (
          <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
            {(start.error as Error).message}
          </div>
        ) : null}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <FeaturePlanLaunch projectId={id} />
          <Link to={`/projects/${id}/deepen`} className="btn btn-ghost text-[12px]">
            deepen
          </Link>
          <Link to={`/projects/${id}/code`} className="btn btn-ghost text-[12px]">
            <FileText size={12} /> code
          </Link>
          {p.githubRemote ? (
            <a
              href={githubHtmlUrlFromClone(p.githubRemote)}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-ghost text-[12px]"
            >
              <ExternalLink size={12} /> github
            </a>
          ) : githubTokenStatus.data?.has ? (
            <button
              type="button"
              onClick={() => setShowPublish(true)}
              className="btn btn-ghost text-[12px]"
            >
              <Upload size={12} /> publish to github
            </button>
          ) : null}
        </div>

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
            tasks.map((t) => {
              const activeRun = activeRunByTask.get(t.id) ?? null;
              const canStart = !activeRun && t.status !== "done" && t.status !== "in_progress";
              return (
                <div key={t.id} className="flex items-stretch">
                  <Link
                    to={`/projects/${id}/tasks/${t.id}`}
                    className="flex-1 min-w-0 px-3 py-2.5 flex items-center gap-3 hover:bg-[var(--color-bg-2)]"
                  >
                    <span className={`chip status-${t.status}`}>{t.status}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] truncate">{t.title}</div>
                      <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                        {t.id} · {String(t.estimate ?? "—")}
                      </div>
                    </div>
                    <ChevronRight size={14} className="text-[var(--color-fg-3)] shrink-0" />
                  </Link>
                  <div className="flex items-center px-2 border-l border-[var(--color-line)]">
                    {activeRun ? (
                      <Link
                        to={`/projects/${id}/runs/${activeRun.id}`}
                        className="btn btn-ghost text-[11px] !h-8 !px-2"
                        aria-label="view active run"
                        title={`view active run ${activeRun.id.slice(0, 8)}`}
                      >
                        <Eye size={12} />
                      </Link>
                    ) : canStart ? (
                      <button
                        type="button"
                        onClick={() => start.mutate({ taskId: t.id })}
                        disabled={start.isPending}
                        className="btn btn-ghost text-[11px] !h-8 !px-2"
                        aria-label="run this task"
                      >
                        <Play size={12} />
                      </button>
                    ) : (
                      <span className="w-8" aria-hidden="true" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {projectPlans.data && projectPlans.data.length > 0 ? (
        <section>
          <SectionHeader
            title="plans"
            count={projectPlans.data.filter((p) => p.status === "drafting").length}
          />
          <div className="surface divide-y divide-[var(--color-line)]">
            {projectPlans.data.map((p) => (
              <Link
                key={p.id}
                to={`/plans/${p.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <ListTree size={12} className="text-[var(--color-fg-3)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">{p.goal || "(unnamed plan)"}</div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {p.kind} · {p.taskId ?? "—"}
                  </div>
                </div>
                <span
                  className={`chip ${
                    p.status === "drafting"
                      ? "chip-decompose"
                      : p.status === "frozen"
                        ? "chip-greenlit"
                        : ""
                  }`}
                >
                  {p.status}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <AuditsSection projectId={id} />

      <SessionsList projectId={id} />

      <ScriptsSection projectId={id} />

      <section>
        <SectionHeader
          title="workdir"
          count={
            workdir.data?.exists
              ? (workdir.data.status.length ?? 0) + (workdir.data.tree.length ?? 0)
              : 0
          }
        />
        <WorkdirPanel projectId={id} data={workdir.data} loading={workdir.isLoading} />
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
            runs.data.map((r) => {
              const isActive = ACTIVE_RUN_STATUSES.has(r.status);
              const m = runMetrics.data?.[r.id];
              const costLabel =
                m && m.totalCostUsd > 0
                  ? m.totalCostUsd < 0.01
                    ? "<$0.01"
                    : `$${m.totalCostUsd.toFixed(2)}`
                  : null;
              return (
                <Link
                  key={r.id}
                  to={`/projects/${id}/runs/${r.id}`}
                  className={`block px-3 py-2.5 hover:bg-[var(--color-bg-2)] ${
                    isActive ? "bg-[var(--color-bg-2)]/60" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <RunStatusChip status={r.status} />
                      <span className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                        {r.id.slice(0, 8)} · {r.taskId ?? "ad-hoc"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {costLabel ? (
                        <span className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)]">
                          {costLabel}
                        </span>
                      ) : null}
                      <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                        {timeAgo(r.startedAt)}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })
          ) : (
            <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">no runs yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function WorkdirPanel({
  projectId,
  data,
  loading,
}: {
  projectId: string;
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
  const codeBase = `/projects/${projectId}/code`;
  return (
    <div className="surface divide-y divide-[var(--color-line)]">
      <div className="px-3 py-2.5 flex items-center gap-2 flex-wrap">
        <GitBranch size={12} className="text-[var(--color-fg-3)]" />
        <Link
          to={`${codeBase}?tab=branches`}
          className="mono text-[12px] text-[var(--color-fg-1)] truncate hover:text-[var(--color-accent)]"
        >
          {branch ?? "(detached)"}
        </Link>
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
            {status.slice(0, 80).map((s) => {
              // Deletions can't be opened in the blob viewer; everything else can.
              const code = s.code.trim();
              const isDeleted = code === "D" || code === "AD" || code === "DD";
              const target = isDeleted
                ? `${codeBase}?tab=tree`
                : `${codeBase}?tab=blob&path=${encodeURIComponent(s.path)}`;
              return (
                <li key={`${s.code}-${s.path}`}>
                  <Link
                    to={target}
                    className="mono text-[11.5px] flex gap-2 leading-snug hover:text-[var(--color-accent)]"
                  >
                    <span className="text-[var(--color-accent)] w-6 shrink-0">{code}</span>
                    <span className="text-[var(--color-fg-1)] truncate">{s.path}</span>
                  </Link>
                </li>
              );
            })}
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
                <Link
                  to={`${codeBase}?tab=commits&ref=${encodeURIComponent(c.sha)}`}
                  className="hover:text-[var(--color-accent)]"
                >
                  <span className="mono text-[11px] text-[var(--color-accent)] mr-2">
                    {c.sha.slice(0, 8)}
                  </span>
                  <span className="text-[var(--color-fg-1)]">{c.subject}</span>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-2">
                    {c.author}
                  </span>
                </Link>
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
                {w.branch ? (
                  <Link
                    to={`${codeBase}?tab=tree&ref=${encodeURIComponent(w.branch)}`}
                    className="text-[var(--color-accent)] mr-2 hover:underline"
                  >
                    {w.branch}
                  </Link>
                ) : (
                  <span className="text-[var(--color-accent)] mr-2">(detached)</span>
                )}
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
              <li key={entry.path}>
                <Link
                  to={`${codeBase}?tab=${entry.type === "dir" ? "tree" : "blob"}&path=${encodeURIComponent(entry.path)}`}
                  className="mono text-[12px] flex items-center gap-2 hover:text-[var(--color-accent)]"
                >
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
                </Link>
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
