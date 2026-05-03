import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ModelPicker } from "../components/model-picker.tsx";
import { getToken } from "../lib/auth.ts";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

interface DecisionComment {
  id: string;
  decisionId: string;
  role: "operator" | "agent";
  body: string;
  createdAt: number;
}

interface DecisionPayload {
  outcome?: string;
  weighted_score?: number;
  uncertainty?: number;
  rationale?: string;
  title_suggestion?: string;
  axes?: Array<{ id: string; score: number; rationale: string }>;
  spec_stub?: {
    summary?: string;
    initial_tasks?: Array<{
      title: string;
      estimate?: string;
      acceptance?: string[];
    }>;
  };
  clarifying_questions?: string[];
  what_would_change_verdict?: string;
  // tag_change shape
  previousTag?: string;
  newTag?: string;
  note?: string | null;
}

type Action = "approve" | "park" | "trash" | "decompose" | "dismiss";

export function DecisionDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const decision = useQuery({
    queryKey: ["decisions.get", id],
    queryFn: () => trpc.decisions.get.query({ id }),
    enabled: id.length > 0,
  });

  const idea = useQuery({
    queryKey: ["ideas.get", decision.data?.ideaId ?? "x"],
    queryFn: () => trpc.ideas.get.query({ id: decision.data?.ideaId ?? "" }),
    enabled: !!decision.data?.ideaId,
  });

  const rubric = useQuery({
    queryKey: ["rubric-version", decision.data?.rubricVersionId ?? "x"],
    queryFn: () =>
      trpc.rubrics.list
        .query()
        .then((rows) => rows.find((r) => r.id === decision.data?.rubricVersionId) ?? null),
    enabled: !!decision.data?.rubricVersionId,
  });

  const [model, setModel] = useState<string | null>(null);

  const action = useMutation({
    mutationFn: (vars: { action: Action }) =>
      trpc.decisions.action.mutate({
        decisionId: id,
        action: vars.action,
        // Model is only meaningful for approve (it stamps the project); the
        // server ignores it for park/trash/decompose/dismiss but sending it
        // anyway keeps the call site simple.
        model: vars.action === "approve" ? model : undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["decisions.get", id] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      if (res.projectId) {
        nav(`/projects/${res.projectId}`);
      } else {
        nav("/");
      }
    },
  });

  const comments = useQuery({
    queryKey: ["decisions.comments", id],
    queryFn: () =>
      trpc.decisions.comments.query({ decisionId: id }) as unknown as Promise<DecisionComment[]>,
    enabled: id.length > 0,
  });

  const sendComment = useMutation({
    mutationFn: (body: string) => trpc.decisions.comment.mutate({ decisionId: id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["decisions.comments", id] });
    },
  });

  const [draft, setDraft] = useState("");

  // /ws/inbox carries comment_added and decision_updated. Filter to this
  // decisionId and invalidate so the thread + header pick up agent replies
  // without the operator refreshing.
  useEffect(() => {
    const token = getToken();
    if (!token || !id) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/inbox?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data) as { kind?: string; decisionId?: string };
          if (evt.decisionId !== id) return;
          if (evt.kind === "comment_added") {
            qc.invalidateQueries({ queryKey: ["decisions.comments", id] });
          }
          if (evt.kind === "decision_updated") {
            qc.invalidateQueries({ queryKey: ["decisions.get", id] });
          }
        } catch {
          // non-JSON frame; ignore
        }
      };
    } catch {
      // socket unavailable — query refetches still cover us
    }
    return () => {
      ws?.close();
    };
  }, [id, qc]);

  if (decision.isLoading) return <DecisionSkeleton />;
  if (!decision.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        decision not found.{" "}
        <Link to="/" className="text-[var(--color-accent)] underline">
          back to inbox
        </Link>
      </div>
    );
  }

  const d = decision.data;
  const payload = (d.payload ?? {}) as DecisionPayload;
  const isTriage = d.kind === "triage";
  const isPending = d.status === "pending";
  const score = d.weightedScore != null ? d.weightedScore.toFixed(2) : "—";
  const uncertainty = d.uncertainty != null ? d.uncertainty.toFixed(2) : "—";
  const headline =
    payload.title_suggestion ?? (idea.data ? idea.data.rawText.slice(0, 80) : d.outcome);

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
          <span className={cn("chip", verdictTone(d.outcome))}>{d.outcome}</span>
          <span className="chip">{isTriage ? "triage" : "tag change"}</span>
          <span className="chip">{d.status}</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {fmtDate(d.createdAt)}
          </span>
        </div>

        <h1 className="display text-[22px] leading-snug text-[var(--color-fg)] mt-1">{headline}</h1>

        {isTriage ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="weighted score" value={score} />
            <Metric label="uncertainty" value={uncertainty} />
          </div>
        ) : null}
      </header>

      {idea.data ? (
        <Section title="idea">
          <div className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg)] whitespace-pre-wrap">
            {idea.data.rawText}
          </div>
        </Section>
      ) : null}

      {payload.rationale ? (
        <Section title="rationale">
          <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)]">
            {payload.rationale}
          </p>
        </Section>
      ) : null}

      {payload.axes && payload.axes.length > 0 ? (
        <Section title="axes">
          <ul className="divide-y divide-[var(--color-line)]">
            {payload.axes.map((a) => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-2)]">
                    {a.id.replace(/_/g, " ")}
                  </span>
                  <span className="display text-[16px] tabular-nums text-[var(--color-accent)]">
                    {a.score}
                    <span className="text-[var(--color-fg-3)] text-[12px] ml-0.5">/10</span>
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--color-fg-1)]">
                  {a.rationale}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {payload.spec_stub ? (
        <Section title="spec stub">
          {payload.spec_stub.summary ? (
            <p className="px-4 py-3 text-[14px] leading-relaxed border-b border-[var(--color-line)]">
              {payload.spec_stub.summary}
            </p>
          ) : null}
          {payload.spec_stub.initial_tasks && payload.spec_stub.initial_tasks.length > 0 ? (
            <ul className="divide-y divide-[var(--color-line)]">
              {payload.spec_stub.initial_tasks.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: tasks are positional within spec_stub
                <li key={`${t.title}-${i}`} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-[14px] text-[var(--color-fg)]">
                      task-{String(i + 1).padStart(3, "0")} · {t.title}
                    </span>
                    {t.estimate ? <span className="chip text-[10px]">{t.estimate}</span> : null}
                  </div>
                  {t.acceptance && t.acceptance.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--color-fg-2)]">
                      {t.acceptance.map((line, j) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: acceptance lines are positional
                          key={`${i}-${j}`}
                          className="leading-snug"
                        >
                          <span className="text-[var(--color-fg-3)]">▢</span> {line}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {payload.clarifying_questions && payload.clarifying_questions.length > 0 ? (
        <Section title="clarifying questions">
          <ol className="px-4 py-3 space-y-2 text-[14px] leading-relaxed text-[var(--color-fg-1)] list-decimal list-inside">
            {payload.clarifying_questions.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {isTriage && (isPending || (comments.data && comments.data.length > 0)) ? (
        <Section title="thread">
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
          ) : null}
          {isPending ? (
            <form
              className={cn(
                "px-4 py-3 space-y-2",
                comments.data && comments.data.length > 0
                  ? "border-t border-[var(--color-line)]"
                  : "",
              )}
              onSubmit={(e) => {
                e.preventDefault();
                const body = draft.trim();
                if (!body) return;
                sendComment.mutate(body, {
                  onSuccess: () => setDraft(""),
                });
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="reply to the agent — answer questions, push back, add context…"
                rows={3}
                className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] resize-y"
                disabled={sendComment.isPending}
              />
              <div className="flex justify-between items-center gap-2">
                <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  the agent will re-score using the rubric
                </span>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={sendComment.isPending || draft.trim().length === 0}
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
        </Section>
      ) : null}

      {payload.what_would_change_verdict ? (
        <Section title="what would change the verdict">
          <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)]">
            {payload.what_would_change_verdict}
          </p>
        </Section>
      ) : null}

      {!isTriage && (payload.previousTag || payload.newTag) ? (
        <Section title="tag change">
          <div className="px-4 py-3 text-[14px] flex items-center gap-2 mono">
            <span className="chip">{payload.previousTag ?? "—"}</span>
            <span className="text-[var(--color-fg-3)]">→</span>
            <span className="chip chip-accent">{payload.newTag ?? "—"}</span>
            {payload.note ? (
              <span className="text-[13px] text-[var(--color-fg-2)] ml-2">{payload.note}</span>
            ) : null}
          </div>
        </Section>
      ) : null}

      {rubric.data ? (
        <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
          rubric · {rubric.data.rubricKey}@{rubric.data.version}
        </p>
      ) : null}

      {isPending && isTriage ? (
        <Section title="model · for runs in this project">
          <div className="px-4 py-3 space-y-1.5">
            <ModelPicker value={model} onChange={setModel} disabled={action.isPending} />
            <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
              applied on approve; can be changed later from the project page.
            </p>
          </div>
        </Section>
      ) : null}

      {isPending ? (
        isTriage ? (
          <div className="grid grid-cols-2 gap-2 sticky bottom-[calc(72px+env(safe-area-inset-bottom))]">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => action.mutate({ action: "approve" })}
              disabled={action.isPending}
            >
              approve
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => action.mutate({ action: "park" })}
              disabled={action.isPending}
            >
              park
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => action.mutate({ action: "decompose" })}
              disabled={action.isPending}
            >
              decompose
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => action.mutate({ action: "trash" })}
              disabled={action.isPending}
            >
              trash
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => action.mutate({ action: "approve" })}
              disabled={action.isPending}
            >
              confirm
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => action.mutate({ action: "dismiss" })}
              disabled={action.isPending}
            >
              dismiss
            </button>
          </div>
        )
      ) : (
        <div className="surface p-3 text-[12px] mono text-[var(--color-fg-3)]">
          this decision is {d.status}
          {d.actionedAt ? ` · ${fmtDate(d.actionedAt)}` : ""}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-2 px-3 py-2">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div className="display text-[20px] tabular-nums text-[var(--color-fg)] mt-0.5">{value}</div>
    </div>
  );
}

function verdictTone(outcome: string): string {
  if (outcome.startsWith("greenlit")) return "chip-greenlit";
  if (outcome.startsWith("parked")) return "chip-parked";
  if (outcome.startsWith("trashed")) return "chip-trashed";
  if (outcome.startsWith("decompose")) return "chip-decompose";
  return "";
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function DecisionSkeleton() {
  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="skel h-4 w-16 mb-3" />
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
