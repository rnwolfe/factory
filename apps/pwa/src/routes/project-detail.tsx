import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  GitBranch,
  ListTree,
  Play,
  Plus,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AuditsSection } from "../components/audits-section.tsx";
import { AutonomyPanel } from "../components/autonomy-panel.tsx";
import { type Ceremony, CeremonyPicker } from "../components/ceremony-picker.tsx";
import { FeaturePlanLaunch } from "../components/feature-plan-launch.tsx";
import { InstantiateTemplateModal } from "../components/instantiate-template-modal.tsx";
import { ProjectMetricsChip } from "../components/metrics-chip.tsx";
import { AgentModelPicker, type AgentName } from "../components/model-picker.tsx";
import { NewTaskModal } from "../components/new-task-modal.tsx";
import type { PlanRow } from "../components/plan-card.tsx";
import { ProjectOverflowMenu } from "../components/project-overflow-menu.tsx";
import { PublishGithubModal } from "../components/publish-github-modal.tsx";
import { type ProjectRole, RolePicker } from "../components/role-picker.tsx";
import { ScriptsSection } from "../components/scripts-section.tsx";
import { SessionsList } from "../components/sessions-list.tsx";
import { SkillsSection } from "../components/skills-section.tsx";
import { type ProvenanceLink, ProvenanceLinks } from "../components/source-link.tsx";
import { type Tag, TagChip } from "../components/tag-chip.tsx";
import { TrustLadder } from "../components/trust-ladder.tsx";
import { useProjectChannel } from "../lib/channels.ts";
import { cn } from "../lib/cn.ts";
import { fmtCost } from "../lib/metrics-format.ts";
import { trpc } from "../lib/trpc.ts";

interface RunRow {
  id: string;
  status: string;
  taskId: string | null;
  startedAt: number;
}

type ProjectTab = "overview" | "tasks" | "runs" | "audits" | "workdir" | "autonomy" | "settings";

const PROJECT_TABS: ReadonlyArray<{ id: ProjectTab; label: string }> = [
  { id: "overview", label: "overview" },
  { id: "tasks", label: "tasks" },
  { id: "runs", label: "runs" },
  { id: "audits", label: "audits" },
  { id: "workdir", label: "workdir" },
  { id: "autonomy", label: "autonomy" },
  { id: "settings", label: "settings" },
];

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

// Tasks split into two groups on the project page: "live" work the operator
// wants to see, and historical (done/dropped) folded behind a toggle so the
// list doesn't grow into a wall as projects accumulate completed work.
const ARCHIVED_TASK_STATUSES = new Set(["done", "dropped"]);

// Cap the runs list at this length on first paint; an explicit "show all"
// reveals the rest. The server already caps at 100, so the absolute max
// is bounded; this is purely a paint/readability cut.
const RUNS_DEFAULT_VISIBLE = 15;

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
  const [showNewTask, setShowNewTask] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showReleasePicker, setShowReleasePicker] = useState(false);
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") ?? "overview") as ProjectTab;
  const setActiveTab = (tab: ProjectTab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };

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

  const githubAppStatus = useQuery({
    queryKey: ["projects.hasGithubApp"],
    queryFn: () => trpc.projects.hasGithubApp.query() as unknown as Promise<{ has: boolean }>,
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

  const setAutonomyMode = useMutation({
    mutationFn: (autonomyMode: "collaborative" | "autonomous") =>
      trpc.projects.setAutonomyMode.mutate({ id, autonomyMode }),
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

  const setAgent = useMutation({
    mutationFn: (agent: AgentName | null) => trpc.projects.setAgent.mutate({ id, agent }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", id] });
    },
  });

  const enableGithubIssues = useMutation({
    mutationFn: () => trpc.projects.enableGithubIssues.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", id] });
    },
  });

  if (project.isLoading) return <ProjectSkeleton />;
  if (!project.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        project not found.{" "}
        <Link to="/projects" className="text-[var(--color-fg-1)] underline">
          back
        </Link>
      </div>
    );
  }

  const {
    project: p,
    tasks,
    hasSpec,
    trust,
    stats,
  } = project.data as unknown as {
    hasSpec?: boolean;
    project: {
      id: string;
      slug: string;
      name: string;
      ceremony: string;
      role: string;
      license: string | null;
      tag: string;
      autoAdvance: boolean;
      autonomyMode: "collaborative" | "autonomous";
      model: string | null;
      agent: AgentName | null;
      githubRemote: string | null;
      taskBackend: "file" | "github-issues";
    };
    tasks: Array<{
      id: string;
      status: string;
      title: string;
      estimate: string | null;
      model?: string | null;
      sourceLinks?: ProvenanceLink[];
      startable?: boolean;
      openBlockers?: string[];
      blocks?: string[];
      blockedBy?: string[];
    }>;
    trust: {
      rung: "supervised" | "collaborative" | "autonomous";
      cleanStreak: number;
      promoteStreak: number;
    };
    stats: {
      runsToday: number;
      mergedToday: number;
      autoMergedToday: number;
      mergedPct: number | null;
    };
  };
  const allRuns = runs.data ?? [];
  const activeRuns = allRuns.filter((r) => ACTIVE_RUN_STATUSES.has(r.status));
  const activeRunByTask = new Map<string, RunRow>();
  for (const r of activeRuns) {
    if (r.taskId && !activeRunByTask.has(r.taskId)) activeRunByTask.set(r.taskId, r);
  }
  const headerActiveRun = activeRuns[0] ?? null;
  const nextStartableTask = tasks.find(
    (t) => t.status === "ready" && t.startable !== false && !activeRunByTask.has(t.id),
  );

  const activeTasks = tasks.filter((t) => !ARCHIVED_TASK_STATUSES.has(t.status));
  const archivedTasks = tasks.filter((t) => ARCHIVED_TASK_STATUSES.has(t.status));
  const visibleRuns = showAllRuns ? allRuns : allRuns.slice(0, RUNS_DEFAULT_VISIBLE);
  const hiddenRunCount = allRuns.length - visibleRuns.length;
  // Overview vitals: "ready" = tasks waiting to be worked (the number the operator
  // actually scans for), not queued RUNS — runs only sit `queued` for the moment
  // they wait on a worker slot, so that count is ~always 0 and reads as misleading
  // next to a backlog of ready tasks. recently-merged = the most recent completed runs.
  const readyTaskCount = tasks.filter((t) => t.status === "ready" && t.startable !== false).length;
  const recentlyMerged = allRuns.filter((r) => r.status === "completed").slice(0, 5);
  const postureLine =
    trust.rung === "autonomous"
      ? "Healthy · running itself"
      : trust.rung === "collaborative"
        ? "Healthy · collaborative"
        : "Healthy · supervised";

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
      {showNewTask ? <NewTaskModal projectId={p.id} onClose={() => setShowNewTask(false)} /> : null}
      {showTemplatePicker ? (
        <InstantiateTemplateModal projectId={p.id} onClose={() => setShowTemplatePicker(false)} />
      ) : null}
      {showReleasePicker ? (
        <InstantiateTemplateModal
          projectId={p.id}
          preselectSlug="release-project"
          onClose={() => setShowReleasePicker(false)}
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
          <button
            type="button"
            onClick={() => setShowNewTask(true)}
            className="btn btn-ghost text-[12px]"
            title="capture a bug or feature for this project"
          >
            <Plus size={12} /> task
          </button>
          <button
            type="button"
            onClick={() => setShowTemplatePicker(true)}
            className="btn btn-ghost text-[12px]"
            title="instantiate a saved task template against this project"
          >
            from template
          </button>
          <button
            type="button"
            onClick={() => setShowReleasePicker(true)}
            className="btn btn-ghost text-[12px]"
            title="cut a release — uses skills/release/SKILL.md if present, generic semver otherwise"
          >
            release
          </button>
          <FeaturePlanLaunch projectId={id} />
          {hasSpec ? (
            <Link
              to={`/projects/${id}/milestone`}
              className="btn btn-ghost text-[12px]"
              title="plan the next milestone from the imported spec"
            >
              plan milestone
            </Link>
          ) : null}
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
          {p.githubRemote && githubAppStatus.data?.has ? (
            p.taskBackend === "github-issues" ? (
              <span className="chip" title="this project's tasks are GitHub Issues">
                tasks · github issues
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Switch this project's tasks to GitHub Issues? Existing task files are backfilled as issues and archived. This can't be auto-undone.",
                    )
                  ) {
                    enableGithubIssues.mutate();
                  }
                }}
                disabled={enableGithubIssues.isPending}
                className="btn btn-ghost text-[12px]"
                title="back tasks with GitHub Issues (backfills existing task files, then archives them)"
              >
                {enableGithubIssues.isPending ? "migrating…" : "use github issues"}
              </button>
            )
          ) : null}
        </div>
        {enableGithubIssues.isError ? (
          <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
            {(enableGithubIssues.error as Error).message}
          </div>
        ) : null}

        <SpendStrip projectId={p.id} />
      </header>

      <ProjectTabStrip active={activeTab} setActive={setActiveTab} />

      <ProjectTabPanel value="overview" active={activeTab}>
        {/* posture — what the system is doing on its own + how far it's let to go */}
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className="pulse-dot inline-block w-2 h-2 rounded-full shrink-0"
                style={{ background: "var(--color-working)" }}
                aria-hidden
              />
              <span className="display text-[16px] text-[var(--color-fg)] truncate">
                {postureLine}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("autonomy")}
              className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] shrink-0"
            >
              tune ›
            </button>
          </div>
          <div className="mt-3">
            <TrustLadder
              rung={trust.rung}
              streak={trust.cleanStreak}
              target={trust.promoteStreak}
              size="inline"
            />
          </div>
        </div>

        {/* 3-up vitals */}
        <div className="grid grid-cols-3 gap-2">
          <div className="surface-2 p-3">
            <div className="display text-[22px] leading-none text-[var(--color-fg)] tabular-nums">
              {readyTaskCount}
            </div>
            <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mt-1.5">
              ready
            </div>
          </div>
          <div className="surface-2 p-3">
            <div className="display text-[22px] leading-none text-[var(--color-fg)] tabular-nums">
              {stats.runsToday}
            </div>
            <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mt-1.5">
              runs today
            </div>
          </div>
          <div className="surface-2 p-3">
            <div className="display text-[22px] leading-none text-[var(--color-fg)] tabular-nums">
              {stats.mergedPct == null ? "—" : `${stats.mergedPct}%`}
            </div>
            <div className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mt-1.5">
              merged
            </div>
          </div>
        </div>

        {/* in flight — runs the system is working right now */}
        {activeRuns.length > 0 ? (
          <section>
            <SectionHeader title="in flight" count={activeRuns.length} />
            <div className="surface divide-y divide-[var(--color-line)]">
              {activeRuns.map((r) => (
                <Link
                  key={r.id}
                  to={`/projects/${id}/runs/${r.id}`}
                  className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
                >
                  <span
                    className="pulse-dot inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: "var(--color-working)" }}
                    aria-hidden
                  />
                  <span className="mono text-[11px] text-[var(--color-working)]">
                    {r.id.slice(0, 8)}
                  </span>
                  <span className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                    {r.taskId ? `task ${r.taskId}` : "ad-hoc"}
                  </span>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto shrink-0">
                    {timeAgo(r.startedAt)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {/* recently merged — completed work, most recent first */}
        {recentlyMerged.length > 0 ? (
          <section>
            <SectionHeader title="recently merged" count={recentlyMerged.length} />
            <div className="surface divide-y divide-[var(--color-line)]">
              {recentlyMerged.map((r) => (
                <Link
                  key={r.id}
                  to={`/projects/${id}/runs/${r.id}`}
                  className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
                >
                  <span className="text-[var(--color-verdict-greenlit)] shrink-0">✓</span>
                  <span className="mono text-[11px] text-[var(--color-fg-1)]">
                    {r.id.slice(0, 8)}
                  </span>
                  <span className="mono text-[11px] text-[var(--color-fg-3)] truncate">
                    {r.taskId ? `task ${r.taskId}` : "ad-hoc"}
                  </span>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto shrink-0">
                    {timeAgo(r.startedAt)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </ProjectTabPanel>

      <ProjectTabPanel value="tasks" active={activeTab}>
        <section>
          <SectionHeader title="tasks" count={activeTasks.length} />
          <div className="surface divide-y divide-[var(--color-line)]">
            {tasks.length === 0 ? (
              <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">
                no tasks yet — first run will create them.
              </div>
            ) : activeTasks.length === 0 ? (
              <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">
                no active tasks — all {archivedTasks.length} done or dropped.
              </div>
            ) : (
              activeTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  projectId={id}
                  task={t}
                  activeRun={activeRunByTask.get(t.id) ?? null}
                  onStart={() => start.mutate({ taskId: t.id })}
                  startDisabled={start.isPending}
                />
              ))
            )}
          </div>

          {archivedTasks.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowArchivedTasks((v) => !v)}
                className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] px-1"
              >
                {showArchivedTasks ? "hide" : "show"} {archivedTasks.length} done/dropped
              </button>
              {showArchivedTasks ? (
                <div className="surface divide-y divide-[var(--color-line)] mt-2">
                  {archivedTasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      projectId={id}
                      task={t}
                      activeRun={null}
                      onStart={() => start.mutate({ taskId: t.id })}
                      startDisabled={start.isPending}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
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
      </ProjectTabPanel>

      <ProjectTabPanel value="runs" active={activeTab}>
        <section>
          <SectionHeader title="runs" count={allRuns.length} />
          <div className="surface divide-y divide-[var(--color-line)]">
            {runs.isLoading ? (
              <div className="px-3 py-4">
                <div className="skel h-4 w-2/3 mb-1" />
                <div className="skel h-3 w-1/3" />
              </div>
            ) : visibleRuns.length > 0 ? (
              visibleRuns.map((r) => {
                const isActive = ACTIVE_RUN_STATUSES.has(r.status);
                const m = runMetrics.data?.[r.id];
                const costLabel =
                  m && m.totalCostUsd > 0
                    ? m.totalCostUsd < 0.01
                      ? "<$0.01"
                      : `$${m.totalCostUsd.toFixed(2)}`
                    : null;
                return (
                  <div
                    key={r.id}
                    className={`block px-3 py-2.5 hover:bg-[var(--color-bg-2)] ${
                      isActive ? "bg-[var(--color-bg-2)]/60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <RunStatusChip status={r.status} />
                        <Link
                          to={`/projects/${id}/runs/${r.id}`}
                          className="mono text-[11px] text-[var(--color-fg-3)] truncate hover:text-[var(--color-accent)]"
                        >
                          {r.id.slice(0, 8)}
                        </Link>
                        {r.taskId ? (
                          <Link
                            to={`/projects/${id}/tasks/${r.taskId}`}
                            className="mono text-[11px] text-[var(--color-accent)] truncate"
                          >
                            task {r.taskId}
                          </Link>
                        ) : (
                          <span className="mono text-[11px] text-[var(--color-fg-3)]">ad-hoc</span>
                        )}
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
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[13px] text-[var(--color-fg-3)]">no runs yet.</div>
            )}
          </div>
          {hiddenRunCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllRuns(true)}
              className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] px-1 mt-2"
            >
              show {hiddenRunCount} more
            </button>
          ) : null}
        </section>

        <SessionsList projectId={id} />
      </ProjectTabPanel>

      <ProjectTabPanel value="audits" active={activeTab}>
        <AuditsSection projectId={id} />
      </ProjectTabPanel>

      <ProjectTabPanel value="workdir" active={activeTab}>
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

        <SkillsSection projectId={id} />

        <ScriptsSection projectId={id} />
      </ProjectTabPanel>

      <ProjectTabPanel value="autonomy" active={activeTab}>
        <section>
          <div className="flex items-center gap-2 px-1 mb-1.5">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              autonomy
            </span>
            <div className="hairline flex-1" />
          </div>
          <p className="px-1 mb-2 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
            per-project autonomy policy. each knob inherits from the system policy unless overridden
            here; the settings tab keeps the at-a-glance agent autonomy mode.
          </p>
          <AutonomyPanel scope="project" projectId={id} />
        </section>
      </ProjectTabPanel>

      <ProjectTabPanel value="settings" active={activeTab}>
        <section className="surface p-4 space-y-4">
          <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-fg-2)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={p.autoAdvance ?? true}
              onChange={(e) => setAutoAdvance.mutate(e.target.checked)}
              disabled={setAutoAdvance.isPending}
              className="accent-[var(--color-working)]"
            />
            <span>auto-advance to next ready task on success</span>
          </label>

          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
              agent autonomy
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["collaborative", "autonomous"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setAutonomyMode.mutate(mode)}
                  disabled={setAutonomyMode.isPending}
                  className={cn(
                    "chip text-[11.5px]",
                    (p.autonomyMode ?? "collaborative") === mode
                      ? "chip-working"
                      : "hover:border-[var(--color-line-bright)]",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1.5">
              {p.autonomyMode === "autonomous"
                ? "agent makes architectural calls silently — choices noted in run summaries only."
                : "agent surfaces architectural / library / naming choices to the inbox without halting the run."}
            </p>
          </div>

          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
              agent · model
            </div>
            <AgentModelPicker
              agent={p.agent ?? "claude-code"}
              model={p.model ?? null}
              onAgentChange={(a) => setAgent.mutate(a)}
              onModelChange={(m) => setModel.mutate(m)}
              disabled={setAgent.isPending || setModel.isPending}
            />
          </div>

          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-verdict-trashed)] mb-1.5">
              danger
            </div>
            <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
              delete this project from the ⋯ menu in the header.
            </p>
          </div>
        </section>
      </ProjectTabPanel>
    </div>
  );
}

function ProjectTabStrip({
  active,
  setActive,
}: {
  active: ProjectTab;
  setActive: (tab: ProjectTab) => void;
}) {
  return (
    <nav
      className="flex items-center gap-4 border-b border-[var(--color-line)] overflow-x-auto whitespace-nowrap"
      aria-label="project sections"
    >
      {PROJECT_TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={cn(
              "relative h-10 shrink-0 mono text-[11.5px] uppercase tracking-[0.18em] transition-colors",
              isActive
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]",
            )}
          >
            {tab.label}
            {isActive ? (
              <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-[var(--color-fg-1)]" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function ProjectTabPanel({
  value,
  active,
  children,
}: {
  value: ProjectTab;
  active: ProjectTab;
  children: React.ReactNode;
}) {
  // Real tabs on every viewport: only the active tab's content is visible.
  return <div className={cn("space-y-4", value !== active && "hidden")}>{children}</div>;
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

function TaskRow({
  projectId,
  task,
  activeRun,
  onStart,
  startDisabled,
}: {
  projectId: string;
  task: {
    id: string;
    status: string;
    title: string;
    estimate: string | null;
    model?: string | null;
    sourceLinks?: ProvenanceLink[];
    startable?: boolean;
    openBlockers?: string[];
    blocks?: string[];
    blockedBy?: string[];
  };
  activeRun: RunRow | null;
  onStart: () => void;
  startDisabled: boolean;
}) {
  const isGated =
    task.status === "ready" && task.startable === false && (task.openBlockers?.length ?? 0) > 0;
  const canStart =
    !activeRun && task.status !== "done" && task.status !== "in_progress" && !isGated;
  const modelShort = shortModelLabel(task.model);
  return (
    <div className="flex items-stretch">
      <div className="flex-1 min-w-0 px-3 py-2.5 flex items-center gap-3 hover:bg-[var(--color-bg-2)]">
        <span className={`chip status-${task.status}`}>{task.status}</span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/projects/${projectId}/tasks/${task.id}`}
            className="block text-[14px] truncate hover:text-[var(--color-accent)]"
          >
            {task.title}
          </Link>
          <div className="mono text-[10.5px] text-[var(--color-fg-3)] flex items-center gap-1.5 flex-wrap">
            <Link
              to={`/projects/${projectId}/tasks/${task.id}`}
              className="hover:text-[var(--color-accent)]"
            >
              {task.id} · {String(task.estimate ?? "—")}
            </Link>
            <ProvenanceLinks links={task.sourceLinks} />
            {isGated ? (
              <span className="chip chip-parked mono text-[10px]">
                blocked · waiting on {(task.openBlockers ?? []).join(", ")}
              </span>
            ) : null}
          </div>
        </div>
        {modelShort ? (
          <span className="chip mono text-[10.5px] shrink-0" title={`pinned to ${task.model}`}>
            {modelShort}
          </span>
        ) : null}
        <ChevronRight size={14} className="text-[var(--color-fg-3)] shrink-0" />
      </div>
      <div className="flex items-center px-2 border-l border-[var(--color-line)]">
        {activeRun ? (
          <Link
            to={`/projects/${projectId}/runs/${activeRun.id}`}
            className="btn btn-ghost text-[11px] !h-8 !px-2"
            aria-label="view active run"
            title={`view active run ${activeRun.id.slice(0, 8)}`}
          >
            <Eye size={12} />
          </Link>
        ) : canStart ? (
          <button
            type="button"
            onClick={onStart}
            disabled={startDisabled}
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
}

/**
 * Compact chip label for a model id. Returns null when the task inherits
 * (no override set on this task) — UI shows nothing rather than "default"
 * to keep the row uncluttered for the common inherits-from-project case.
 */
function shortModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  // Unknown / custom model id: show the trailing segment as a fallback so
  // operators using a non-default model id can still see what's pinned.
  const tail = model.split(/[/-]/).pop() ?? model;
  return tail.slice(0, 10);
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
        ? "chip-working"
        : status === "queued"
          ? ""
          : status === "deferred" || status === "needs_review"
            ? "chip-decompose"
            : status === "failed" || status === "aborted" || status === "blocked"
              ? "chip-trashed"
              : "";
  return <span className={`chip ${tone}`}>{status === "needs_review" ? "review" : status}</span>;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---- Spend sparkline strip ----

const SPARK_W = 400;
const SPARK_H = 36;

function Sparkline({
  days,
  buckets,
}: {
  days: string[];
  buckets: Array<{ totalCostUsd: number }>;
}) {
  const n = days.length;
  if (n === 0) return null;
  const maxVal = Math.max(...buckets.map((b) => b.totalCostUsd), 1e-9);
  const slotW = SPARK_W / n;
  const barW = Math.max(1.5, slotW * 0.8);
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="w-full h-auto"
      aria-label="30-day spend sparkline"
    >
      {/* Baseline */}
      <line
        x1={0}
        y1={SPARK_H - 0.5}
        x2={SPARK_W}
        y2={SPARK_H - 0.5}
        stroke="hsl(30 5% 22%)"
        strokeWidth={0.75}
      />
      {days.map((day, di) => {
        const val = buckets[di]?.totalCostUsd ?? 0;
        if (val <= 0) return null;
        const barH = Math.max(2, (val / maxVal) * (SPARK_H - 3));
        return (
          <rect
            key={day}
            x={di * slotW + (slotW - barW) / 2}
            y={SPARK_H - barH - 1}
            width={barW}
            height={barH}
            fill="var(--color-working)"
            opacity={0.82}
          />
        );
      })}
    </svg>
  );
}

function SpendStrip({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  const dailyQ = useQuery({
    queryKey: ["metrics.daily.sparkline", projectId],
    queryFn: () =>
      trpc.metrics.daily.query({
        start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        end: new Date().toISOString(),
        projectId,
        groupBy: "none",
      }) as unknown as Promise<{
        days: string[];
        series: Array<{ key: string | null; buckets: Array<{ totalCostUsd: number }> }>;
      }>,
    enabled: projectId.length > 0,
    staleTime: 120_000,
    refetchInterval: 120_000,
  });

  const buckets = dailyQ.data?.series?.[0]?.buckets ?? [];
  const days = dailyQ.data?.days ?? [];
  const totalCost = buckets.reduce((sum, b) => sum + b.totalCostUsd, 0);

  if (dailyQ.data && totalCost <= 0) return null;
  if (!dailyQ.data && !dailyQ.isLoading) return null;

  return (
    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 group"
      >
        <div className="flex items-center gap-2">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] group-hover:text-[var(--color-fg-1)] transition-colors">
            30d spend
          </span>
          {dailyQ.isLoading ? (
            <span className="skel h-3 w-10 rounded" />
          ) : totalCost > 0 ? (
            <span className="mono text-[11.5px] tabular-nums text-[var(--color-fg-2)]">
              {fmtCost(totalCost)}
            </span>
          ) : null}
        </div>
        <ChevronDown
          size={11}
          className={cn("text-[var(--color-fg-3)] transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <Link
          to={`/metrics?projectId=${projectId}`}
          className="block mt-2 group/spark hover:opacity-90 transition-opacity"
          title="view full metrics"
        >
          <Sparkline days={days} buckets={buckets} />
          <span className="mt-1.5 flex items-center justify-end gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] group-hover/spark:text-[var(--color-accent)] transition-colors">
            full metrics
            <ChevronRight size={11} />
          </span>
        </Link>
      ) : null}
    </div>
  );
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
