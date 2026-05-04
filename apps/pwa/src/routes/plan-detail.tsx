import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Snowflake, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MetricsChip } from "../components/metrics-chip.tsx";
import {
  type AnyDraftView,
  type FeaturePlanDraftView,
  PlanDraftViewer,
  type ProjectSpecDraftView,
  type ProjectVisionDraftView,
  type RefinementDraftView,
  type TaskPlanDraftView,
} from "../components/plan-draft-viewer.tsx";
import { getToken } from "../lib/auth.ts";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

interface PlanComment {
  id: string;
  planId: string;
  role: "operator" | "agent";
  body: string;
  resultingDraft: string | null;
  createdAt: number;
}

interface PlanRow {
  id: string;
  kind: "project_spec" | "task_plan" | "refinement" | "feature_plan" | "project_vision";
  status: "drafting" | "frozen" | "abandoned" | "superseded";
  decisionId: string | null;
  projectId: string | null;
  taskId: string | null;
  goal: string;
  draft: string;
  createdAt: number;
  updatedAt: number;
  frozenAt: number | null;
  abandonedAt: number | null;
  supersededBy?: string | null;
  tier?: "tinker" | "personal" | "share" | "productize" | null;
}

function safeParseDraft(raw: string, kind: PlanRow["kind"]): AnyDraftView | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (kind === "project_spec") return obj as ProjectSpecDraftView;
    if (kind === "task_plan") return obj as TaskPlanDraftView;
    if (kind === "refinement") return obj as RefinementDraftView;
    if (kind === "feature_plan") return obj as FeaturePlanDraftView;
    if (kind === "project_vision") return obj as ProjectVisionDraftView;
    return null;
  } catch {
    return null;
  }
}

function kindLabel(kind: PlanRow["kind"]): string {
  switch (kind) {
    case "project_spec":
      return "project spec";
    case "task_plan":
      return "task plan";
    case "refinement":
      return "refinement";
    case "feature_plan":
      return "feature plan";
    case "project_vision":
      return "project vision";
  }
}

function freezeConsumerHint(kind: PlanRow["kind"]): string {
  switch (kind) {
    case "project_spec":
      return "freeze creates the project on disk and bootstraps the task files.";
    case "task_plan":
      return "freeze marks the plan authoritative; the next run on this task picks it up.";
    case "refinement":
      return "freeze rewrites the task body with revised acceptance and emits any follow-up tasks.";
    case "feature_plan":
      return "freeze emits the planned tasks into the project.";
    case "project_vision":
      return "freeze writes docs/internal/VISION.md and supersedes any prior vision plan.";
  }
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

export function PlanDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const plan = useQuery({
    queryKey: ["plans.get", id],
    queryFn: () => trpc.plans.get.query({ id }) as unknown as Promise<PlanRow | null>,
    enabled: id.length > 0,
    refetchInterval: 6_000,
  });

  const comments = useQuery({
    queryKey: ["plans.comments", id],
    queryFn: () => trpc.plans.comments.query({ planId: id }) as unknown as Promise<PlanComment[]>,
    enabled: id.length > 0,
  });

  const [draftText, setDraftText] = useState("");
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  const sendComment = useMutation({
    mutationFn: (body: string) => trpc.plans.comment.mutate({ planId: id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plans.comments", id] });
    },
  });

  const freeze = useMutation({
    mutationFn: () => trpc.plans.freeze.mutate({ planId: id }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["plans.get", id] });
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      if (res.projectId && plan.data?.kind === "project_spec") {
        nav(`/projects/${res.projectId}`);
      } else if (res.projectId && res.taskId) {
        nav(`/projects/${res.projectId}/tasks/${res.taskId}`);
      }
    },
  });

  const abandon = useMutation({
    mutationFn: () => trpc.plans.abandon.mutate({ planId: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["plans.get", id] });
      nav("/");
    },
  });

  // Subscribe to /ws/inbox for plan_* events relevant to this id.
  useEffect(() => {
    const token = getToken();
    if (!token || !id) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/inbox?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data) as { kind?: string; planId?: string };
          if (evt.planId !== id) return;
          if (evt.kind === "plan_comment_added") {
            qc.invalidateQueries({ queryKey: ["plans.comments", id] });
          }
          if (evt.kind === "plan_updated") {
            qc.invalidateQueries({ queryKey: ["plans.get", id] });
          }
          if (evt.kind === "plan_frozen" || evt.kind === "plan_abandoned") {
            qc.invalidateQueries({ queryKey: ["plans.get", id] });
            qc.invalidateQueries({ queryKey: ["plans.inbox"] });
          }
        } catch {
          // ignore non-JSON frames
        }
      };
    } catch {
      // socket unavailable — refetch interval covers us
    }
    return () => {
      ws?.close();
    };
  }, [id, qc]);

  const parsedDraft = useMemo(() => {
    if (!plan.data) return null;
    return safeParseDraft(plan.data.draft, plan.data.kind);
  }, [plan.data]);

  if (plan.isLoading) return <PlanSkeleton />;
  if (!plan.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        plan not found.{" "}
        <Link to="/" className="text-[var(--color-accent)] underline">
          back to inbox
        </Link>
      </div>
    );
  }

  const p = plan.data;
  const isDrafting = p.status === "drafting";
  const projectLink =
    p.projectId && p.kind !== "project_spec" ? (
      <Link
        to={`/projects/${p.projectId}`}
        className="mono text-[10.5px] text-[var(--color-accent)] underline"
      >
        project
      </Link>
    ) : null;

  return (
    <div className="space-y-3 pb-4">
      <header className="surface p-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> inbox
        </Link>

        <div className="flex items-center gap-2 mt-3 mb-2 flex-wrap">
          <span className={cn("chip", "chip-decompose")}>{kindLabel(p.kind)}</span>
          <span className="chip">{p.status}</span>
          {projectLink}
          {p.taskId ? <span className="mono text-[11px]">· {p.taskId}</span> : null}
          <MetricsChip ownerKind="plan_iteration" ownerId={p.id} />
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {fmtDate(p.updatedAt)}
          </span>
        </div>

        <h1 className="display text-[20px] leading-snug text-[var(--color-fg)] mt-1">
          {p.goal || "(unnamed plan)"}
        </h1>

        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2">
          created {fmtDate(p.createdAt)}
          {p.frozenAt ? ` · frozen ${fmtDate(p.frozenAt)}` : ""}
          {p.abandonedAt ? ` · abandoned ${fmtDate(p.abandonedAt)}` : ""}
          {p.tier ? ` · tier ${p.tier}` : ""}
        </p>

        {p.status === "superseded" && p.supersededBy ? (
          <div className="mt-3 surface px-3 py-2 mono text-[11.5px] text-[var(--color-fg-2)]">
            superseded by{" "}
            <Link to={`/plans/${p.supersededBy}`} className="text-[var(--color-accent)] underline">
              plan #{p.supersededBy.slice(0, 8)}
            </Link>
          </div>
        ) : null}
      </header>

      <div className="px-1">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            draft
          </span>
          <div className="hairline flex-1" />
        </div>
        {parsedDraft ? (
          <PlanDraftViewer draft={parsedDraft} />
        ) : (
          <div className="surface px-4 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            (draft unavailable — agent has not produced a parseable payload yet.)
          </div>
        )}
      </div>

      <section>
        <div className="flex items-center gap-2 px-1 mb-1.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            thread
          </span>
          <div className="hairline flex-1" />
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {comments.data?.length ?? 0}
          </span>
        </div>
        <div className="surface">
          {comments.data && comments.data.length > 0 ? (
            <ul className="divide-y divide-[var(--color-line)]">
              {comments.data.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span
                      className={cn(
                        "mono text-[10.5px] uppercase tracking-[0.18em]",
                        c.role === "operator"
                          ? "text-[var(--color-fg-1)]"
                          : "text-[var(--color-accent)]",
                      )}
                    >
                      {c.role}
                      {c.resultingDraft ? (
                        <span className="ml-2 text-[var(--color-fg-3)] normal-case">
                          · draft updated
                        </span>
                      ) : null}
                    </span>
                    <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                      {fmtDate(c.createdAt)}
                    </span>
                  </div>
                  <p className="text-[14px] leading-relaxed text-[var(--color-fg)] whitespace-pre-wrap">
                    {c.body}
                  </p>
                </li>
              ))}
              {sendComment.isPending ||
              (comments.data.length > 0 &&
                comments.data[comments.data.length - 1]?.role === "operator") ? (
                <li className="px-4 py-3">
                  <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
                    agent · thinking
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="skel h-2.5 w-2.5 rounded-full" />
                    <span className="skel h-2.5 w-2.5 rounded-full" />
                    <span className="skel h-2.5 w-2.5 rounded-full" />
                  </div>
                </li>
              ) : null}
            </ul>
          ) : (
            <div className="px-4 py-3 text-[13px] text-[var(--color-fg-3)]">no messages yet.</div>
          )}

          {isDrafting ? (
            <form
              className={cn(
                "px-4 py-3 space-y-2",
                comments.data && comments.data.length > 0
                  ? "border-t border-[var(--color-line)]"
                  : "",
              )}
              onSubmit={(e) => {
                e.preventDefault();
                const body = draftText.trim();
                if (!body) return;
                sendComment.mutate(body, { onSuccess: () => setDraftText("") });
              }}
            >
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="reply to the agent — push back, add context, ask for decomposition…"
                rows={3}
                className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] resize-y"
                disabled={sendComment.isPending}
              />
              <div className="flex justify-between items-center gap-2">
                <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  the agent re-drafts after each comment
                </span>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={sendComment.isPending || draftText.trim().length === 0}
                >
                  {sendComment.isPending ? "sending…" : "send"}
                </button>
              </div>
              {sendComment.isError ? (
                <p className="mono text-[11px] text-[var(--color-verdict-trashed)]">
                  {(sendComment.error as Error).message}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      </section>

      {isDrafting ? (
        confirmFreeze ? (
          <div className="surface p-4 space-y-3">
            <div className="display text-[15px] text-[var(--color-fg)]">freeze this plan?</div>
            <p className="text-[13px] text-[var(--color-fg-2)] leading-relaxed">
              {freezeConsumerHint(p.kind)} the plan becomes read-only.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmFreeze(false)}
                disabled={freeze.isPending}
              >
                cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => freeze.mutate()}
                disabled={freeze.isPending}
              >
                {freeze.isPending ? "freezing…" : "yes, freeze"}
              </button>
            </div>
            {freeze.isError ? (
              <p className="mono text-[11px] text-[var(--color-verdict-trashed)]">
                {(freeze.error as Error).message}
              </p>
            ) : null}
          </div>
        ) : confirmAbandon ? (
          <div className="surface p-4 space-y-3">
            <div className="display text-[15px] text-[var(--color-fg)]">abandon this plan?</div>
            <p className="text-[13px] text-[var(--color-fg-2)] leading-relaxed">
              this plan disappears from the inbox and cannot be resumed.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmAbandon(false)}
                disabled={abandon.isPending}
              >
                cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => abandon.mutate()}
                disabled={abandon.isPending}
              >
                {abandon.isPending ? "abandoning…" : "yes, abandon"}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sticky bottom-[calc(72px+env(safe-area-inset-bottom))]">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirmFreeze(true)}
            >
              <Snowflake size={14} /> freeze
            </button>
            <button type="button" className="btn" onClick={() => setConfirmAbandon(true)}>
              <Trash2 size={14} /> abandon
            </button>
          </div>
        )
      ) : (
        <div className="surface p-3 text-[12px] mono text-[var(--color-fg-3)]">
          this plan is {p.status}
          {p.frozenAt ? ` · ${fmtDate(p.frozenAt)}` : ""}
          {p.abandonedAt ? ` · ${fmtDate(p.abandonedAt)}` : ""}
        </div>
      )}
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="skel h-3 w-16 mb-3" />
        <div className="skel h-4 w-32 mb-2" />
        <div className="skel h-7 w-3/4 mb-2" />
      </div>
      <div className="surface p-4">
        <div className="skel h-3 w-1/4 mb-2" />
        <div className="skel h-4 w-full mb-1" />
        <div className="skel h-4 w-2/3" />
      </div>
    </div>
  );
}
