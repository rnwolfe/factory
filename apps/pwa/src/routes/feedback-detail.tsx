import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ListPlus, Loader2, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFeedbackChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";

interface FeedbackRow {
  id: string;
  vote: "up" | "down";
  body: string;
  contextRoute: string | null;
  contextHint: string | null;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  createdAt: number;
  resolvedAt: number | null;
  resolvedTarget: string | null;
  claudeSessionId: string | null;
}

interface FeedbackComment {
  id: string;
  feedbackId: string;
  role: "operator" | "agent";
  body: string;
  resultingDraft: string | null;
  createdAt: number;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function parseTarget(t: string | null):
  | { kind: "plan"; id: string }
  | {
      kind: "task";
      projectId: string;
      taskId: string;
    }
  | null {
  if (!t) return null;
  const planMatch = /^plan:(.+)$/.exec(t);
  if (planMatch?.[1]) return { kind: "plan", id: planMatch[1] };
  const taskMatch = /^task:([^:]+):(.+)$/.exec(t);
  if (taskMatch?.[1] && taskMatch[2]) {
    return { kind: "task", projectId: taskMatch[1], taskId: taskMatch[2] };
  }
  return null;
}

export function FeedbackDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [body, setBody] = useState("");

  const row = useQuery({
    queryKey: ["feedback.get", id],
    queryFn: () => trpc.feedback.get.query({ id }) as unknown as Promise<FeedbackRow | null>,
    enabled: id.length > 0,
    // WS now drives invalidations; poll only as a fallback for dropped events.
    refetchInterval: 30_000,
  });

  const comments = useQuery({
    queryKey: ["feedback.comments", id],
    queryFn: () =>
      trpc.feedback.comments.query({ feedbackId: id }) as unknown as Promise<FeedbackComment[]>,
    enabled: id.length > 0,
    refetchInterval: 30_000,
  });

  // Per-feedback scoped channel — agent reply lands here without a poll.
  useFeedbackChannel(id || null, [
    ["feedback.get", id],
    ["feedback.comments", id],
  ]);

  const config = useQuery({
    queryKey: ["feedback.config"],
    queryFn: () =>
      trpc.feedback.config.query() as unknown as Promise<{ factoryProjectId: string | null }>,
    staleTime: 60_000,
  });

  const comment = useMutation({
    mutationFn: (text: string) => trpc.feedback.comment.mutate({ feedbackId: id, body: text }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["feedback.comments", id] });
      qc.invalidateQueries({ queryKey: ["feedback.get", id] });
    },
  });

  const dismiss = useMutation({
    mutationFn: () => trpc.feedback.dismiss.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
      qc.invalidateQueries({ queryKey: ["feedback.get", id] });
      nav("/");
    },
  });

  const promotePlan = useMutation({
    mutationFn: () => trpc.feedback.promoteToPlan.mutate({ feedbackId: id }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
      qc.invalidateQueries({ queryKey: ["feedback.get", id] });
      nav(`/plans/${(res as { planId: string }).planId}`);
    },
  });

  const promoteTask = useMutation({
    mutationFn: () => trpc.feedback.promoteToTask.mutate({ feedbackId: id }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
      qc.invalidateQueries({ queryKey: ["feedback.get", id] });
      const r = res as { projectId: string; taskId: string };
      nav(`/projects/${r.projectId}/tasks/${r.taskId}`);
    },
  });

  if (!id) {
    return (
      <div className="surface p-3 text-[13px]">
        missing id.{" "}
        <Link to="/" className="text-[var(--color-accent)] underline">
          back
        </Link>
      </div>
    );
  }

  if (row.isLoading) {
    return (
      <div className="surface p-3">
        <div className="skel h-4 w-1/3 mb-2" />
        <div className="skel h-3 w-3/4" />
      </div>
    );
  }

  if (!row.data) {
    return (
      <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
        feedback not found.
      </div>
    );
  }

  const r = row.data;
  const thread = comments.data ?? [];
  const lastIsOperator = thread.length > 0 && thread[thread.length - 1]?.role === "operator";
  const promoteAvailable = Boolean(config.data?.factoryProjectId);
  const target = parseTarget(r.resolvedTarget);

  return (
    <div className="space-y-3 pb-4 md:max-w-3xl md:mx-auto">
      <header className="surface p-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> inbox
        </Link>
        <div className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2 flex items-center gap-2 flex-wrap">
          {r.vote === "up" ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
          <span>feedback</span>
          <span className={`chip ${r.status === "resolved" ? "chip-greenlit" : ""}`}>
            {r.status}
          </span>
        </div>
        <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 flex items-center gap-2 flex-wrap">
          <span>{fmtDate(r.createdAt)}</span>
          {r.contextHint ? (
            <>
              <span>·</span>
              <span>{r.contextHint}</span>
            </>
          ) : null}
          {r.contextRoute ? (
            <>
              <span>·</span>
              <span className="truncate">{r.contextRoute}</span>
            </>
          ) : null}
        </div>
        {target ? (
          <div className="mt-2 mono text-[11px] text-[var(--color-fg-3)]">
            resolved →{" "}
            {target.kind === "plan" ? (
              <Link to={`/plans/${target.id}`} className="text-[var(--color-accent)] underline">
                plan {target.id.slice(0, 8)}
              </Link>
            ) : (
              <Link
                to={`/projects/${target.projectId}/tasks/${target.taskId}`}
                className="text-[var(--color-accent)] underline"
              >
                {target.taskId}
              </Link>
            )}
          </div>
        ) : null}
        {r.status === "open" || r.status === "in_progress" ? (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => promotePlan.mutate()}
              disabled={!promoteAvailable || promotePlan.isPending}
              title={
                promoteAvailable ? undefined : "set factoryProjectId in ~/.factory/config.yaml"
              }
              className="btn btn-primary text-[12px]"
            >
              {promotePlan.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> promoting…
                </>
              ) : (
                <>
                  <CheckCircle2 size={12} /> promote to plan
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => promoteTask.mutate()}
              disabled={!promoteAvailable || promoteTask.isPending}
              title={
                promoteAvailable ? undefined : "set factoryProjectId in ~/.factory/config.yaml"
              }
              className="btn btn-ghost text-[12px]"
            >
              <ListPlus size={12} /> promote to task
            </button>
            <button
              type="button"
              onClick={() => dismiss.mutate()}
              disabled={dismiss.isPending}
              className="btn btn-ghost text-[12px]"
            >
              <X size={12} /> dismiss
            </button>
          </div>
        ) : null}
        {!promoteAvailable ? (
          <p className="mt-2 mono text-[10.5px] text-[var(--color-fg-3)] leading-relaxed">
            promote disabled — set{" "}
            <span className="text-[var(--color-fg-2)]">factoryProjectId</span> in{" "}
            <span className="text-[var(--color-fg-2)]">~/.factory/config.yaml</span> to point at
            this repo (after importing it as a project).
          </p>
        ) : null}
      </header>

      <pre className="surface p-3 mono text-[12.5px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words">
        {r.body}
      </pre>

      <div className="space-y-2">
        {thread.map((c) => (
          <div
            key={c.id}
            className={`surface p-3 ${
              c.role === "operator" ? "border-l-2 border-[var(--color-accent)]" : ""
            }`}
          >
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1 flex items-center gap-2">
              <span>{c.role}</span>
              <span>·</span>
              <span>{fmtDate(c.createdAt)}</span>
              {c.resultingDraft ? <span className="chip ml-1">draft</span> : null}
            </div>
            <pre className="mono text-[12px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words">
              {c.body}
            </pre>
          </div>
        ))}
        {lastIsOperator ? (
          <div className="surface p-3 mono text-[11px] text-[var(--color-fg-3)] flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> thinking…
          </div>
        ) : null}
      </div>

      {r.status === "open" || r.status === "in_progress" ? (
        <div className="surface p-3 space-y-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="reply to the agent…"
            className="w-full px-2 py-1.5 mono text-[12.5px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between">
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
              {body.length} / 2000
            </span>
            <button
              type="button"
              onClick={() => comment.mutate(body)}
              disabled={body.length === 0 || comment.isPending}
              className="btn btn-primary text-[12px]"
            >
              {comment.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> sending…
                </>
              ) : (
                "reply"
              )}
            </button>
          </div>
          {comment.isError ? (
            <div className="text-[12px] text-[var(--color-verdict-trashed)]">
              {(comment.error as Error).message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
