import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function FeedbackDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const row = useQuery({
    queryKey: ["feedback.get", id],
    queryFn: () => trpc.feedback.get.query({ id }) as unknown as Promise<FeedbackRow | null>,
    enabled: id.length > 0,
  });

  const dismiss = useMutation({
    mutationFn: () => trpc.feedback.dismiss.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
      qc.invalidateQueries({ queryKey: ["feedback.get", id] });
      nav("/");
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

  return (
    <div className="space-y-3 pb-4">
      <header className="surface p-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> inbox
        </Link>
        <div className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2 flex items-center gap-2">
          {r.vote === "up" ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
          <span>feedback</span>
          <span className={`chip chip-${r.status === "resolved" ? "greenlit" : ""}`}>
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
        {r.status === "open" || r.status === "in_progress" ? (
          <div className="mt-3 flex items-center gap-2">
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
      </header>

      <pre className="surface p-3 mono text-[12.5px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words">
        {r.body}
      </pre>

      <p className="px-1 mono text-[10.5px] text-[var(--color-fg-3)] leading-relaxed">
        agent thread + promote-to-plan / promote-to-task come in cut 6 (D2). for now, dismiss when
        addressed.
      </p>
    </div>
  );
}
