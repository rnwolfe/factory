import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AuditFinding, AuditRow } from "../components/audit-card.tsx";
import { FindingCard } from "../components/finding-card.tsx";
import { MarkdownView } from "../components/markdown-view.tsx";
import { AuditMetricsChip } from "../components/metrics-chip.tsx";
import { PromoteFindingsModal } from "../components/promote-findings-modal.tsx";
import { useAuditChannel } from "../lib/channels.ts";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

interface AuditCommentRow {
  id: string;
  auditId: string;
  role: "operator" | "agent";
  body: string;
  createdAt: number;
}

function parseFindings(raw: string | null | undefined): AuditFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditFinding[]) : [];
  } catch {
    return [];
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

export function AuditPane() {
  const params = useParams();
  const auditId = params.auditId ?? "";
  const projectId = params.id ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPromote, setShowPromote] = useState(false);
  const [comment, setComment] = useState("");

  const audit = useQuery({
    queryKey: ["audits.get", auditId],
    queryFn: () => trpc.audits.get.query({ id: auditId }) as unknown as Promise<AuditRow | null>,
    enabled: auditId.length > 0,
    // Slow safety-net poll. Live updates arrive via the scoped /ws/events
    // channel below; running audits still poll faster so the operator sees
    // mid-run progress in case a WS message is dropped.
    refetchInterval: (q) => {
      const data = q.state.data as AuditRow | null | undefined;
      if (!data) return 30_000;
      return data.status === "running" ? 5_000 : 30_000;
    },
  });

  const project = useQuery({
    queryKey: ["projects.get", projectId],
    queryFn: () => trpc.projects.get.query({ id: projectId }),
    enabled: projectId.length > 0,
  });

  // Mark reviewed on first open of a completed audit. Idempotent on the daemon.
  useEffect(() => {
    if (audit.data?.status === "completed") {
      void trpc.audits.markReviewed.mutate({ auditId }).catch(() => {
        // best-effort; not critical
      });
    }
  }, [audit.data?.status, auditId]);

  const comments = useQuery({
    queryKey: ["audits.comments", auditId],
    queryFn: () => trpc.audits.comments.query({ auditId }) as unknown as Promise<AuditCommentRow[]>,
    enabled: auditId.length > 0,
  });

  // Scoped WS push for audit_* events on this audit only — refetches both
  // the audit row (status changes) and the comments thread (agent replies).
  useAuditChannel(auditId || null, [
    ["audits.get", auditId],
    ["audits.comments", auditId],
  ]);

  const approve = useMutation({
    mutationFn: () => trpc.audits.approve.mutate({ auditId }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["audits.get", auditId] });
      qc.invalidateQueries({ queryKey: ["audits.list", projectId] });
    },
  });

  const reject = useMutation({
    mutationFn: () => trpc.audits.reject.mutate({ auditId }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["audits.get", auditId] });
      qc.invalidateQueries({ queryKey: ["audits.list", projectId] });
    },
  });

  const sendComment = useMutation({
    mutationFn: (body: string) => trpc.audits.comment.mutate({ auditId, body }),
    onSuccess: () => {
      setComment("");
      qc.invalidateQueries({ queryKey: ["audits.comments", auditId] });
    },
  });

  const findings = useMemo(() => parseFindings(audit.data?.findings), [audit.data?.findings]);
  const selectedFindings = useMemo(
    () => findings.filter((f) => selected.has(f.id)),
    [findings, selected],
  );

  if (audit.isLoading) return <div className="p-4 text-[var(--color-fg-2)]">loading…</div>;
  if (!audit.data) {
    return (
      <div className="surface p-4">
        <div className="display text-[var(--color-verdict-trashed)] mb-2">audit not found</div>
        <Link to={`/projects/${projectId}`} className="btn btn-ghost">
          <ArrowLeft size={16} /> back to project
        </Link>
      </div>
    );
  }
  const a = audit.data;
  const projectName = project.data?.project?.name ?? "audit";
  const isReviewable = a.status === "completed" || a.status === "reviewed";
  const finalState = a.status === "approved" || a.status === "rejected" || a.status === "failed";

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="surface px-4 py-3 flex items-center gap-2 flex-wrap">
        <Link
          to={`/projects/${projectId}`}
          className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} />
        </Link>
        <div>
          <div className="display text-[16px] text-[var(--color-fg)]">{a.skillName}</div>
          <div className="mono text-[10.5px] text-[var(--color-fg-3)]">{projectName}</div>
        </div>
        <div className="flex-1" />
        <span className="chip">{a.status}</span>
        <AuditMetricsChip auditId={a.id} />
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
          {timeAgo(a.completedAt ?? a.startedAt)} ago
        </span>
      </div>

      {a.status === "running" ? (
        <div className="surface px-4 py-3 mono text-[11.5px] text-[var(--color-fg-2)]">
          audit in progress — agent reading the project. results land here when done.
        </div>
      ) : null}

      {a.status === "failed" ? (
        <div className="surface border-l-2 border-[var(--color-verdict-trashed)] p-3">
          <div className="display text-[13.5px] text-[var(--color-verdict-trashed)] mb-1">
            audit failed
          </div>
          <MarkdownView
            source={a.reportMarkdown ?? "(no report)"}
            storageKey={`mdView.audit-failed.${auditId}`}
            defaultMode="raw"
          />
        </div>
      ) : null}

      {a.reportMarkdown && a.status !== "failed" && a.status !== "running" ? (
        <div className="surface p-4">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
            report
          </div>
          <MarkdownView source={a.reportMarkdown} storageKey={`mdView.audit-report.${auditId}`} />
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              findings ({findings.length})
            </span>
            <div className="flex-1" />
            {isReviewable && selectedFindings.length > 0 ? (
              <button
                type="button"
                className="btn btn-primary text-[12px]"
                onClick={() => setShowPromote(true)}
              >
                promote {selectedFindings.length}
              </button>
            ) : null}
          </div>
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li key={f.id}>
                <FindingCard
                  finding={f}
                  selected={selected.has(f.id)}
                  onToggle={
                    isReviewable && f.promotedTo === null
                      ? () => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(f.id)) next.delete(f.id);
                            else next.add(f.id);
                            return next;
                          });
                        }
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {isReviewable ? (
        <div className="surface p-3 flex items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => approve.mutate()}
            disabled={approve.isPending || reject.isPending}
          >
            <CheckCheck size={14} /> approve & commit
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => reject.mutate()}
            disabled={approve.isPending || reject.isPending}
          >
            <X size={14} /> reject
          </button>
        </div>
      ) : null}

      {a.approvedReportPath ? (
        <div className="surface p-3 mono text-[11px] text-[var(--color-fg-2)]">
          report committed to{" "}
          <span className="text-[var(--color-fg-1)]">{a.approvedReportPath}</span>
        </div>
      ) : null}

      {a.reportMarkdown && a.status !== "running" && a.status !== "failed" ? (
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
                      </span>
                      <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                        {fmtDate(c.createdAt)}
                      </span>
                    </div>
                    <div className="text-[14px] leading-relaxed text-[var(--color-fg)]">
                      <MarkdownView source={c.body} storageKey={`mdView.audit-comment.${c.id}`} />
                    </div>
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
              <div className="px-4 py-3 text-[13px] text-[var(--color-fg-3)]">
                no follow-ups yet.
              </div>
            )}

            {!finalState ? (
              <form
                className={cn(
                  "px-4 py-3 space-y-2",
                  comments.data && comments.data.length > 0
                    ? "border-t border-[var(--color-line)]"
                    : "",
                )}
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = comment.trim();
                  if (!body) return;
                  sendComment.mutate(body);
                }}
              >
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder="ask the agent to clarify a finding…"
                  className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] resize-y"
                  disabled={sendComment.isPending}
                />
                <div className="flex justify-between items-center gap-2">
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    the agent resumes the audit's session to reply
                  </span>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={sendComment.isPending || comment.trim().length === 0}
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
      ) : null}

      {showPromote ? (
        <PromoteFindingsModal
          auditId={auditId}
          findings={selectedFindings}
          onClose={() => setShowPromote(false)}
          onPromoted={(res) => {
            setShowPromote(false);
            setSelected(new Set());
            qc.invalidateQueries({ queryKey: ["audits.get", auditId] });
            if (res.recommendation === "plan" && res.planId) {
              nav(`/plans/${res.planId}`);
            } else if (res.recommendation === "bug" && res.taskId && projectId) {
              nav(`/projects/${projectId}/tasks/${res.taskId}`);
            }
          }}
        />
      ) : null}
    </div>
  );
}
