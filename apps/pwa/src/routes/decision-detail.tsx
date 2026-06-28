import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { decisionProjectLabel } from "../components/decision-card.tsx";
import { InterventionPane } from "../components/intervention-pane.tsx";
import { MarkdownView } from "../components/markdown-view.tsx";
import { type AgentName, useAgentRegistry } from "../components/model-picker.tsx";
import { RecoveryPrompt } from "../components/recovery-prompt.tsx";
import { SourceIssueLink, sourceIssueLabel } from "../components/source-link.tsx";
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

interface DecisionAxis {
  id: string;
  score: number;
  rationale: string;
  /** v2 prompts add anchor + evidence; older payloads omit them. */
  anchor_band_hit?: string;
  evidence?: string;
}

interface DecomposeQuestion {
  question: string;
  blocking_axis?: string;
  expected_signal?: string;
}

interface DecisionPayload {
  outcome?: string;
  weighted_score?: number;
  uncertainty?: number;
  rationale?: string;
  title_suggestion?: string;
  axes?: DecisionAxis[];
  spec_stub?: {
    summary?: string;
    initial_tasks?: Array<{
      title: string;
      estimate?: string;
      acceptance?: string[];
    }>;
  };
  /** v1 flat-string clarifying questions. */
  clarifying_questions?: string[];
  /** v2 structured decompose questions. */
  decompose_questions?: DecomposeQuestion[];
  what_would_change_verdict?: string;
  // tag_change shape
  previousTag?: string;
  newTag?: string;
  note?: string | null;
  // blocked_run / merge_failure shape
  runId?: string;
  taskId?: string | null;
  summary?: string;
  questions?: string[];
  branch?: string;
  // blocked_run variants: same kind, three causes. Default (neither set)
  // means the agent self-blocked with questions.
  usageCapped?: boolean;
  failed?: boolean;
  // merge_failure-only
  reason?: string;
  message?: string;
  // agent_decision shape
  kind?: "architectural" | "library" | "naming" | "scope" | "tradeoff";
  responseType?: "single" | "multi" | "free";
  context?: string;
  decided?: string;
  options?: Array<{ title: string; tradeoff: string; chosen: boolean }>;
  reasoning?: string;
  // issue_intake shape — an externally-filed GitHub issue offered for adoption
  number?: number;
  title?: string;
  author?: string;
  htmlUrl?: string;
  // release_proposal shape — model-resolved version + rendered release body
  version?: string | null;
  body?: string;
  // watch_insight shape — an observation The Watch synthesized (ADR-010).
  // `title` above is shared; the watch-only fields are here.
  observationId?: string;
  observationKind?:
    | "repeated-ritual"
    | "new-convention"
    | "correction-pattern"
    | "candidate-task"
    | "tooling-gap";
  detail?: string;
  proposal?: "adopt-as-task" | "record-as-convention" | "note-only" | "draft-feature-plan";
  evidence?: Array<{ sourceId: string; sessionId: string }>;
  targetProjectSlug?: string | null;
  override?:
    | { kind: "single"; choice: string }
    | { kind: "multi"; choices: string[] }
    | { kind: "custom"; text: string };
  overrideAt?: number;
  /** Follow-up task the override resurfaced into (task-064). */
  resurfacedTaskId?: string | null;
}

type Action = "approve" | "park" | "trash" | "decompose" | "dismiss";

export function DecisionDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const agentRegistry = useAgentRegistry();

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

  const action = useMutation({
    mutationFn: (vars: { action: Action; agent?: AgentName }) =>
      trpc.decisions.action.mutate({
        decisionId: id,
        action: vars.action,
        agent: vars.agent,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["decisions.get", id] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      // Triage approval now routes through a project_spec foundry plan;
      // jump the operator into iteration immediately. Other approve flows
      // (blocked_run retry, merge_failure retry) still surface a project.
      if (res.planId) {
        nav(`/plans/${res.planId}`);
      } else if (res.projectId) {
        nav(`/projects/${res.projectId}`);
      } else {
        nav("/");
      }
    },
  });

  type Override =
    | { kind: "single"; choice: string }
    | { kind: "multi"; choices: string[] }
    | { kind: "custom"; text: string };

  const overrideAgentDecision = useMutation({
    mutationFn: (override: Override) =>
      trpc.decisions.overrideAgentDecision.mutate({ decisionId: id, override }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["decisions.get", id] });
      qc.invalidateQueries({ queryKey: ["projects.tasks"] });
      // The override re-queued a concrete unit of work via the task-store seam
      // (task-062). Navigate the operator straight into the resurfaced task so
      // they can act on it, keeping momentum.
      if (res.resurfacedTaskId && res.projectId) {
        nav(`/projects/${res.projectId}/tasks/${res.resurfacedTaskId}`);
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

  const activeIntervention = useQuery({
    queryKey: ["interventions.forDecision", id],
    queryFn: () =>
      trpc.interventions.forDecision.query({ decisionId: id }) as unknown as Promise<{
        id: string;
        decisionId: string;
        decisionKind: "blocked_run" | "merge_failure";
        worktreePath: string;
        tmuxSessionName: string;
        status: "active" | "resumed" | "cancelled" | "orphaned";
        startedAt: number;
        endedAt: number | null;
      } | null>,
    enabled: id.length > 0,
  });

  // The blocker→reply→re-run dialog chain (task-049) — a queryable history of
  // how this blocked run was unblocked.
  const dialogChain = useQuery({
    queryKey: ["interventions.dialogChain", id],
    queryFn: () =>
      trpc.interventions.dialogChain.query({ decisionId: id }) as unknown as Promise<
        Array<{
          id: string;
          blockerQuestions: string[] | null;
          operatorReply: string | null;
          retryRunId: string | null;
          status: string;
          outcome: string | null;
          startedAt: number;
          endedAt: number | null;
        }>
      >,
    enabled: id.length > 0,
  });

  const startIntervention = useMutation({
    mutationFn: () => trpc.interventions.start.mutate({ decisionId: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["interventions.forDecision", id] });
    },
  });

  const [draft, setDraft] = useState("");
  // null = inherit (task → project → settings). Otherwise pin this retry to
  // the named agent. Reset whenever the decision-detail view mounts; the
  // operator opts in per-retry.
  const [retryAgent, setRetryAgent] = useState<AgentName | null>(null);

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
            // Interventions emit decision_updated on start/cancel/orphan
            // so the pane shows up / goes away without a refresh.
            qc.invalidateQueries({ queryKey: ["interventions.forDecision", id] });
          }
          if (evt.kind === "decision_actioned") {
            qc.invalidateQueries({ queryKey: ["decisions.get", id] });
            qc.invalidateQueries({ queryKey: ["interventions.forDecision", id] });
            qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
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
  const isBlockedRun = d.kind === "blocked_run";
  const isMergeFailure = d.kind === "merge_failure";
  const isAgentDecision = d.kind === "agent_decision";
  const isIssueIntake = d.kind === "issue_intake";
  const isReleaseProposal = d.kind === "release_proposal";
  const isWatchInsight = d.kind === "watch_insight";
  const isPending = d.status === "pending";
  // The Watch / Trust Ladder (ADR-012): an `agent_decision` fork the agent made
  // on an autonomous-tier run, auto-ratified rather than surfaced. It's out of
  // the pending inbox but still OVERRIDABLE post-hoc — the safety valve.
  const isAutoRatified = d.status === "auto_ratified";
  const score = d.weightedScore != null ? d.weightedScore.toFixed(2) : "—";
  const uncertainty = d.uncertainty != null ? d.uncertainty.toFixed(2) : "—";
  const issueNumber = typeof payload.number === "number" ? payload.number : null;
  const issueTitle = typeof payload.title === "string" ? payload.title : "";
  const issueHtmlUrl =
    typeof payload.htmlUrl === "string" && payload.htmlUrl.length > 0 ? payload.htmlUrl : null;
  const headline = isMergeFailure
    ? `merge to main failed${payload.taskId ? ` for ${payload.taskId}` : ""} — ${payload.reason ?? "unknown"}`
    : isAgentDecision
      ? (payload.summary ?? d.outcome)
      : isIssueIntake
        ? (sourceIssueLabel(issueNumber, issueTitle) ?? "GitHub issue")
        : isReleaseProposal
          ? `release ${payload.version ?? "(version pending)"}`
          : isWatchInsight
            ? (payload.title ?? "Insight from The Watch")
            : (payload.title_suggestion ??
              (idea.data ? idea.data.rawText.slice(0, 80) : d.outcome));
  // The Watch's adopt verb depends on the proposal + whether there's a project.
  const watchAdoptLabel = !isWatchInsight
    ? "acknowledge"
    : d.projectId && payload.proposal === "adopt-as-task"
      ? "adopt as task"
      : d.projectId && payload.proposal === "draft-feature-plan"
        ? "draft feature plan"
        : "acknowledge";
  const watchEvidenceCount = Array.isArray(payload.evidence) ? payload.evidence.length : 0;

  return (
    <div className="space-y-3 pb-4 md:max-w-3xl md:mx-auto">
      <header className="surface p-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> inbox
        </Link>

        <div className="flex items-center gap-2 mt-3 mb-2 flex-wrap">
          <span className={cn("chip", verdictTone(d.outcome))}>{d.outcome}</span>
          <span className="chip">
            {isTriage
              ? "triage"
              : isBlockedRun
                ? payload.failed
                  ? "failed run"
                  : payload.usageCapped
                    ? "usage cap"
                    : "blocked run"
                : isMergeFailure
                  ? "merge failure"
                  : isAgentDecision
                    ? `agent · ${payload.kind ?? "decision"}`
                    : isIssueIntake
                      ? "issue · intake"
                      : isReleaseProposal
                        ? "release"
                        : isWatchInsight
                          ? "watch · insight"
                          : "tag change"}
          </span>
          {isAutoRatified ? (
            <span
              className="chip chip-accent"
              title="the agent decided this autonomously — you didn't need to"
            >
              auto-decided
            </span>
          ) : (
            <span className="chip">{d.status}</span>
          )}
          <span className="chip">{decisionProjectLabel(d)}</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {fmtDate(d.createdAt)}
          </span>
        </div>

        <h1 className="display text-[22px] leading-snug text-[var(--color-fg)] mt-1 break-words [overflow-wrap:anywhere]">
          {isIssueIntake ? (
            <SourceIssueLink
              number={issueNumber}
              title={issueTitle}
              href={issueHtmlUrl}
              className="break-words [overflow-wrap:anywhere]"
            />
          ) : (
            headline
          )}
        </h1>

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

      {isAgentDecision ? (
        <>
          {payload.context ? (
            <Section title="context">
              <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap">
                {payload.context}
              </p>
            </Section>
          ) : null}
          {payload.options && payload.options.length > 0 ? (
            <Section title="options the agent considered">
              <ul className="divide-y divide-[var(--color-line)]">
                {payload.options.map((opt, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: options are positional within a single decision
                    key={i}
                    className="px-4 py-3"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-0.5">
                      <span
                        className={cn(
                          "text-[14px] text-[var(--color-fg)]",
                          opt.chosen ? "font-medium" : "",
                        )}
                      >
                        {opt.title}
                      </span>
                      {opt.chosen ? (
                        <span className="chip chip-accent text-[10.5px]">chosen</span>
                      ) : null}
                    </div>
                    {opt.tradeoff ? (
                      <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                        {opt.tradeoff}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {payload.reasoning ? (
            <Section title="agent reasoning">
              <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap">
                {payload.reasoning}
              </p>
            </Section>
          ) : null}
          {payload.runId ? (
            <Section title="source run">
              <Link
                to={`/projects/${d.projectId ?? ""}/runs/${payload.runId}`}
                className="px-4 py-3 flex items-center gap-2 text-[13px] mono text-[var(--color-fg-1)] hover:text-[var(--color-accent)]"
              >
                run {payload.runId.slice(0, 8)}
                {payload.taskId ? <span> · {payload.taskId}</span> : null}
              </Link>
            </Section>
          ) : null}

          {isPending ? (
            <Section title="your call">
              <AgentDecisionOverrideForm
                responseType={payload.responseType ?? "single"}
                options={payload.options ?? []}
                agentDecided={payload.decided ?? ""}
                isSubmitting={overrideAgentDecision.isPending}
                onRatify={() => action.mutate({ action: "approve" })}
                onSubmit={(o) => overrideAgentDecision.mutate(o)}
                error={
                  overrideAgentDecision.isError
                    ? (overrideAgentDecision.error as Error).message
                    : null
                }
              />
            </Section>
          ) : isAutoRatified && !payload.override ? (
            <Section title="auto-decided — override if needed">
              <div className="px-4 py-3 space-y-3">
                <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
                  The agent made this call autonomously and Factory auto-ratified it — you didn't
                  need to weigh in. If you disagree, override below and the work resurfaces as a
                  follow-up task carrying your direction.
                </p>
                <AgentDecisionOverrideForm
                  responseType={payload.responseType ?? "single"}
                  options={payload.options ?? []}
                  agentDecided={payload.decided ?? ""}
                  ratifiable={false}
                  isSubmitting={overrideAgentDecision.isPending}
                  onRatify={() => {}}
                  onSubmit={(o) => overrideAgentDecision.mutate(o)}
                  error={
                    overrideAgentDecision.isError
                      ? (overrideAgentDecision.error as Error).message
                      : null
                  }
                />
              </div>
            </Section>
          ) : payload.override ? (
            <Section title="resurfaced as open work">
              <div className="px-4 py-3 text-[13.5px] leading-relaxed text-[var(--color-fg-1)] space-y-2.5">
                <p className="text-[13px] text-[var(--color-fg-2)]">
                  You overrode the agent's call — this didn't close. It resurfaced as open work that
                  still needs implementing.
                </p>
                <div>
                  <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mr-2">
                    you require
                  </span>
                  {payload.override.kind === "single"
                    ? payload.override.choice
                    : payload.override.kind === "multi"
                      ? payload.override.choices.join(", ")
                      : payload.override.text}
                </div>
                {payload.resurfacedTaskId && d.projectId ? (
                  <Link
                    to={`/projects/${d.projectId}/tasks/${payload.resurfacedTaskId}`}
                    className="btn btn-primary w-full"
                  >
                    open follow-up task · {payload.resurfacedTaskId.slice(0, 8)}
                  </Link>
                ) : (
                  <p className="mono text-[10.5px] text-[var(--color-fg-3)] leading-snug">
                    no project backend to re-queue into — the override is recorded here, but you'll
                    implement it yourself.
                  </p>
                )}
                {payload.overrideAt ? (
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    overridden {fmtDate(payload.overrideAt)}
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}
        </>
      ) : null}

      {isIssueIntake ? (
        <Section title="github issue">
          <div className="px-4 py-3 space-y-2 text-[14px] leading-relaxed text-[var(--color-fg-1)]">
            <p className="break-words [overflow-wrap:anywhere]">
              <SourceIssueLink
                number={issueNumber}
                title={issueTitle}
                href={issueHtmlUrl}
                className="font-medium break-words [overflow-wrap:anywhere]"
              />{" "}
              filed by{" "}
              <span className="text-[var(--color-fg)]">@{payload.author ?? "unknown"}</span> on
              GitHub.
            </p>
            <p className="text-[13px] text-[var(--color-fg-2)]">
              promote to adopt it as a task on this project — Factory takes over the issue (the
              comment thread becomes run context; runs comment back as the bot). dismiss leaves the
              issue untouched on GitHub.
            </p>
          </div>
        </Section>
      ) : null}

      {isReleaseProposal ? (
        <Section title="release notes">
          <div className="px-4 py-3 space-y-3 text-[14px] leading-relaxed text-[var(--color-fg-1)]">
            <p className="text-[13px] text-[var(--color-fg-2)]">
              Version{" "}
              <span className="text-[var(--color-fg)]">{payload.version ?? "(pending)"}</span> was
              determined from the change set since the last tag. Confirm to cut the release (bump +
              changelog + tag); dismiss to discard. Editing the version/notes pre-confirm is a
              follow-up — for now, dismiss and re-trigger if the version is wrong.
            </p>
            {payload.body ? (
              <pre className="mono text-[12px] leading-relaxed text-[var(--color-fg-2)] whitespace-pre-wrap break-words max-h-[480px] overflow-y-auto">
                {payload.body}
              </pre>
            ) : (
              <p className="text-[var(--color-fg-3)]">no rendered body</p>
            )}
          </div>
        </Section>
      ) : null}

      {isWatchInsight ? (
        <Section title="the watch">
          <div className="px-4 py-3 space-y-3 text-[14px] leading-relaxed text-[var(--color-fg-1)]">
            {payload.detail ? <p>{payload.detail}</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {payload.observationKind ? (
                <span className="chip">{payload.observationKind.replace(/-/g, " ")}</span>
              ) : null}
              {payload.proposal ? (
                <span className="chip">{payload.proposal.replace(/-/g, " ")}</span>
              ) : null}
              <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
                from {watchEvidenceCount} session{watchEvidenceCount === 1 ? "" : "s"}
              </span>
            </div>
            <p className="text-[13px] text-[var(--color-fg-2)]">
              The Watch synthesized this from your out-of-band work. {watchAdoptLabel} to act on it,
              or dismiss to clear it — this is a notify-grade nudge, never a blocking review.
            </p>
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
                {a.anchor_band_hit ? (
                  <p className="mono text-[11px] text-[var(--color-fg-3)] leading-snug mb-1">
                    band: {a.anchor_band_hit}
                  </p>
                ) : null}
                {a.evidence ? (
                  <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)] italic mb-1">
                    “{a.evidence}”
                  </p>
                ) : null}
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

      {payload.decompose_questions && payload.decompose_questions.length > 0 ? (
        <Section title="clarifying questions">
          <ol className="px-4 py-3 space-y-3 text-[14px] leading-relaxed text-[var(--color-fg-1)] list-decimal list-inside">
            {payload.decompose_questions.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional
              <li key={i} className="space-y-1">
                <div>{q.question}</div>
                {q.blocking_axis || q.expected_signal ? (
                  <div className="ml-5 mono text-[11px] text-[var(--color-fg-3)] leading-snug">
                    {q.blocking_axis ? (
                      <span>
                        blocking:{" "}
                        <span className="text-[var(--color-fg-2)]">{q.blocking_axis}</span>
                      </span>
                    ) : null}
                    {q.blocking_axis && q.expected_signal ? <span> · </span> : null}
                    {q.expected_signal ? <span>need: {q.expected_signal}</span> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : payload.clarifying_questions && payload.clarifying_questions.length > 0 ? (
        <Section title="clarifying questions">
          <ol className="px-4 py-3 space-y-2 text-[14px] leading-relaxed text-[var(--color-fg-1)] list-decimal list-inside">
            {payload.clarifying_questions.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {(isTriage || isBlockedRun || isIssueIntake || isAgentDecision) &&
      (isPending || (comments.data && comments.data.length > 0)) ? (
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
                  <div className="text-[14px] leading-relaxed text-[var(--color-fg)]">
                    <MarkdownView source={c.body} storageKey={`mdView.decision-comment.${c.id}`} />
                  </div>
                </li>
              ))}
              {/* Every commentable kind now fires an agent reply on each
                  operator comment; show a thinking placeholder while we wait.
                  (blocked_run's answers also ride forward into the retry.) */}
              {(isTriage || isIssueIntake || isBlockedRun || isAgentDecision) &&
              (sendComment.isPending ||
                (comments.data.length > 0 &&
                  comments.data[comments.data.length - 1]?.role === "operator")) ? (
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
                placeholder={
                  isBlockedRun
                    ? payload.failed
                      ? "add context for the retry — the agent replies, and your notes ride forward when you retry…"
                      : "answer the agent's questions — the agent replies, and your notes ride forward when you retry…"
                    : isIssueIntake
                      ? "reply to the agent — your message posts to the GitHub issue and the agent responds…"
                      : "reply to the agent — answer questions, push back, add context…"
                }
                rows={3}
                className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] resize-y"
                disabled={sendComment.isPending}
              />
              <div className="flex justify-between items-center gap-2">
                <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  {isBlockedRun
                    ? "the agent replies here — and your answers fold into the retry"
                    : isIssueIntake
                      ? "posts to the GitHub issue — the agent replies"
                      : isAgentDecision
                        ? "the agent replies here — mirrored to the issue if github-backed"
                        : "the agent will re-score using the rubric"}
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

      {isBlockedRun ? (
        <>
          {payload.summary ? (
            <Section title="agent summary">
              <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap">
                {payload.summary}
              </p>
            </Section>
          ) : null}
          {payload.questions && payload.questions.length > 0 ? (
            <Section title="open questions">
              <ul className="divide-y divide-[var(--color-line)]">
                {payload.questions.map((q) => (
                  <li
                    key={q}
                    className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)]"
                  >
                    {q}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {payload.runId && d.projectId ? (
            <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
              source run ·{" "}
              <Link
                to={`/projects/${d.projectId}/runs/${payload.runId}`}
                className="text-[var(--color-accent)] underline"
              >
                {payload.runId.slice(0, 8)}
              </Link>
              {payload.branch ? ` · ${payload.branch}` : ""}
            </p>
          ) : null}
          {dialogChain.data && dialogChain.data.length > 0 ? (
            <Section title="intervention history">
              <ul className="divide-y divide-[var(--color-line)]">
                {dialogChain.data.map((iv) => (
                  <li key={iv.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
                        blocker → reply → re-run
                      </span>
                      <span
                        className={cn(
                          "chip",
                          iv.outcome === "completed"
                            ? "chip-greenlit"
                            : iv.outcome === "needs_review"
                              ? "chip-decompose"
                              : iv.status === "active"
                                ? "chip-accent"
                                : "chip-trashed",
                        )}
                      >
                        {iv.outcome ?? iv.status}
                      </span>
                    </div>
                    {iv.operatorReply ? (
                      <div className="text-[13px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap line-clamp-4">
                        {iv.operatorReply}
                      </div>
                    ) : null}
                    {iv.retryRunId && d.projectId ? (
                      <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
                        retry ·{" "}
                        <Link
                          to={`/projects/${d.projectId}/runs/${iv.retryRunId}`}
                          className="text-[var(--color-accent)] underline"
                        >
                          {iv.retryRunId.slice(0, 8)}
                        </Link>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
            retry resumes from this run's branch tip — partial work and the auto-commit ride
            forward. operator replies in the thread fold into the new run's prompt.
          </p>
          {isPending ? <RecoveryPrompt decisionId={id} /> : null}
          {isPending ? (
            <Section title="retry agent">
              <div className="px-4 py-3 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRetryAgent(null)}
                    className={cn(
                      "chip mono cursor-pointer",
                      retryAgent === null ? "chip-accent" : "",
                    )}
                    title="use the task / project / settings default"
                  >
                    inherit
                  </button>
                  {agentRegistry.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setRetryAgent(opt.id as AgentName)}
                      className={cn(
                        "chip mono cursor-pointer",
                        retryAgent === opt.id ? "chip-accent" : "",
                      )}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  override the retry's agent. model still inherits from the task / project.
                </p>
              </div>
            </Section>
          ) : null}
          {isPending &&
          (comments.data?.filter((c) => c.role === "operator").length ?? 0) === 0 &&
          payload.questions &&
          payload.questions.length > 0 ? (
            <p className="px-2 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
              no operator reply yet — retrying without answers will likely re-block on the same
              questions.
            </p>
          ) : null}
        </>
      ) : null}

      {isMergeFailure ? (
        <>
          {payload.message ? (
            <Section title="git error">
              <p className="px-4 py-3 mono text-[12px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words">
                {payload.message}
              </p>
            </Section>
          ) : null}
          {payload.summary ? (
            <Section title="agent summary">
              <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap">
                {payload.summary}
              </p>
            </Section>
          ) : null}
          {payload.runId && d.projectId ? (
            <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
              source run ·{" "}
              <Link
                to={`/projects/${d.projectId}/runs/${payload.runId}`}
                className="text-[var(--color-accent)] underline"
              >
                {payload.runId.slice(0, 8)}
              </Link>
              {payload.branch ? ` · ${payload.branch}` : ""}
            </p>
          ) : null}
          <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
            the agent's commits live on the run's branch — retry merges them into main once the
            blocker is cleared. dismiss leaves them on the branch.
          </p>
          {isPending ? <RecoveryPrompt decisionId={id} /> : null}
        </>
      ) : null}

      {/* Active intervention pane — when the operator has opened a tmux to
          repair the blocked run / merge failure, the pane is the primary
          attention surface. Retry/dismiss buttons are hidden in that mode
          so the operator's only choices are "resume agent" / "cancel"
          inside the pane. */}
      {(isBlockedRun || isMergeFailure) && activeIntervention.data ? (
        <InterventionPane intervention={activeIntervention.data} projectId={d.projectId} />
      ) : null}

      {rubric.data ? (
        <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
          rubric · {rubric.data.rubricKey}@{rubric.data.version}
        </p>
      ) : null}

      {isPending && isTriage ? (
        <Section title="approve creates a project_spec plan">
          <div className="px-4 py-3 space-y-1.5">
            <p className="text-[13px] leading-relaxed text-[var(--color-fg-1)]">
              the project doesn't materialize on approve — it materializes when you freeze the
              project_spec plan. iterate with the agent in the inbox, then freeze.
            </p>
            <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
              set the project's claude model from the project page after freeze.
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
        ) : isAgentDecision ? (
          // For agent_decision the "your call" section above already has
          // ratify + override controls. Bottom row is just an escape hatch.
          <div className="grid grid-cols-1">
            <button
              type="button"
              className="btn"
              onClick={() => action.mutate({ action: "dismiss" })}
              disabled={action.isPending}
            >
              dismiss without action
            </button>
          </div>
        ) : (isBlockedRun || isMergeFailure) && activeIntervention.data ? (
          // Active intervention is the only action surface — the pane has
          // its own resume/cancel buttons, so the bottom action bar
          // would be redundant and confusing.
          <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
            intervention active above — resume or cancel from the tmux pane.
          </p>
        ) : isBlockedRun || isMergeFailure ? (
          // blocked_run + merge_failure get a third "intervene" verb that
          // opens a tmux over the relevant worktree (run's for blocked,
          // project's for merge_failure) so the operator can resolve the
          // problem in-place before retrying.
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                action.mutate({
                  action: "approve",
                  ...(isBlockedRun && retryAgent ? { agent: retryAgent } : {}),
                })
              }
              disabled={action.isPending || startIntervention.isPending}
            >
              {isBlockedRun ? "retry" : "retry merge"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => startIntervention.mutate()}
              disabled={action.isPending || startIntervention.isPending}
              title={
                isBlockedRun
                  ? "open a tmux over the run's worktree to inspect/edit before resuming the agent"
                  : "open a tmux over the project's main checkout to resolve the conflict before retrying"
              }
            >
              {startIntervention.isPending ? "starting…" : "intervene"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => action.mutate({ action: "dismiss" })}
              disabled={action.isPending || startIntervention.isPending}
            >
              dismiss
            </button>
          </div>
        ) : isIssueIntake ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => action.mutate({ action: "approve" })}
              disabled={action.isPending}
            >
              promote to task
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
        ) : isReleaseProposal ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => action.mutate({ action: "approve" })}
              disabled={action.isPending}
            >
              cut release
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
        ) : isWatchInsight ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => action.mutate({ action: "approve" })}
              disabled={action.isPending}
            >
              {watchAdoptLabel}
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
      ) : isAgentDecision && payload.override ? (
        // An overridden agent_decision is resolved as a decision but its work is
        // still open — don't let the footer read as a dead "actioned" end. The
        // "resurfaced as open work" section above carries the follow-up link.
        <div className="surface p-3 text-[12px] mono text-[var(--color-fg-3)]">
          decision resolved · resurfaced as open work
          {payload.resurfacedTaskId ? " (see follow-up task above)" : ""}
        </div>
      ) : isAutoRatified ? (
        // Auto-ratified, not (yet) overridden: the override surface above is the
        // live action — the footer is just a quiet status line.
        <div className="surface p-3 text-[12px] mono text-[var(--color-fg-3)]">
          auto-ratified by Factory{d.actionedAt ? ` · ${fmtDate(d.actionedAt)}` : ""} · override
          above if needed
        </div>
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
  if (outcome === "blocked") return "chip-trashed";
  if (outcome.startsWith("merge:")) return "chip-trashed";
  return "";
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

type OverrideSubmission =
  | { kind: "single"; choice: string }
  | { kind: "multi"; choices: string[] }
  | { kind: "custom"; text: string };

interface OverrideFormProps {
  responseType: "single" | "multi" | "free";
  options: Array<{ title: string; tradeoff: string; chosen: boolean }>;
  agentDecided: string;
  isSubmitting: boolean;
  onRatify: () => void;
  onSubmit: (override: OverrideSubmission) => void;
  error: string | null;
  // When false (auto-ratified decisions), the "agent's choice" tab is hidden —
  // the decision is already ratified, so ratifying again is meaningless. Only
  // the override paths (pick different / custom) are offered. Defaults to true
  // for the pending-inbox flow.
  ratifiable?: boolean;
}

/**
 * Override surface for an `agent_decision`. The shape of the form is
 * driven by `responseType`:
 *
 * - `single`: a radio-list of agent options. Operator picks a different
 *   option, or toggles to "custom answer" and types one. Ratify just
 *   accepts the agent's pick.
 * - `multi`: a checkbox-list of agent options pre-selected per the
 *   agent's choices. Operator can change which subset is selected. Same
 *   custom-answer escape hatch.
 * - `free`: no options; only a textarea. The agent's free-form answer is
 *   pre-filled so the operator can edit instead of starting blank.
 *
 * Submitting routes through `decisions.overrideAgentDecision` which
 * marks the decision actioned and opens (or comments on) a refinement
 * plan against the source task.
 */
function AgentDecisionOverrideForm({
  responseType,
  options,
  agentDecided,
  isSubmitting,
  onRatify,
  onSubmit,
  error,
  ratifiable = true,
}: OverrideFormProps) {
  // Initial single choice: agent's pick (the option marked chosen, falling
  // back to the first option, then to the literal `decided` if no options).
  const initialSingle = options.find((o) => o.chosen)?.title ?? options[0]?.title ?? agentDecided;
  const initialMulti = options.filter((o) => o.chosen).map((o) => o.title);

  // Auto-ratified decisions can't be re-ratified — start on an override mode.
  const initialMode: "agent" | "options" | "custom" = ratifiable
    ? "agent"
    : options.length > 0 && responseType !== "free"
      ? "options"
      : "custom";
  const [mode, setMode] = useState<"agent" | "options" | "custom">(initialMode);
  const [singleChoice, setSingleChoice] = useState(initialSingle);
  const [multiChoices, setMultiChoices] = useState<string[]>(initialMulti);
  const [customText, setCustomText] = useState(responseType === "free" ? agentDecided : "");

  const canSubmit = (() => {
    if (mode === "agent") return true;
    if (mode === "custom") return customText.trim().length > 0;
    if (responseType === "multi") return multiChoices.length > 0;
    return singleChoice.trim().length > 0;
  })();

  const submit = () => {
    if (mode === "agent") {
      onRatify();
      return;
    }
    if (mode === "custom") {
      onSubmit({ kind: "custom", text: customText.trim() });
      return;
    }
    if (responseType === "multi") {
      onSubmit({ kind: "multi", choices: multiChoices });
    } else {
      onSubmit({ kind: "single", choice: singleChoice });
    }
  };

  const submitLabel = (() => {
    if (mode === "agent") return "ratify agent's choice";
    if (mode === "custom") return "submit custom answer";
    return "submit override";
  })();

  return (
    <div className="px-4 py-3 space-y-4">
      <ModeTabs
        mode={mode}
        setMode={setMode}
        responseType={responseType}
        hasOptions={options.length > 0}
        showAgentTab={ratifiable}
      />

      {mode === "agent" ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
          Accepts the agent's call: <span className="text-[var(--color-fg)]">{agentDecided}</span>.
          The decision card closes; no follow-up plan is created.
        </p>
      ) : null}

      {mode === "options" && responseType === "single" ? (
        <ul className="space-y-1.5">
          {options.map((opt) => (
            <li key={opt.title}>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="agent-decision-single"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={singleChoice === opt.title}
                  onChange={() => setSingleChoice(opt.title)}
                />
                <span className="flex-1 text-[13.5px] leading-snug text-[var(--color-fg)]">
                  <span className={opt.chosen ? "font-medium" : ""}>{opt.title}</span>
                  {opt.chosen ? (
                    <span className="ml-1.5 chip chip-accent text-[10px]">agent's pick</span>
                  ) : null}
                  {opt.tradeoff ? (
                    <span className="block text-[12px] text-[var(--color-fg-2)] mt-0.5">
                      {opt.tradeoff}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}

      {mode === "options" && responseType === "multi" ? (
        <ul className="space-y-1.5">
          {options.map((opt) => {
            const checked = multiChoices.includes(opt.title);
            return (
              <li key={opt.title}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--color-accent)]"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMultiChoices((cur) => [...cur, opt.title]);
                      } else {
                        setMultiChoices((cur) => cur.filter((c) => c !== opt.title));
                      }
                    }}
                  />
                  <span className="flex-1 text-[13.5px] leading-snug text-[var(--color-fg)]">
                    <span className={opt.chosen ? "font-medium" : ""}>{opt.title}</span>
                    {opt.chosen ? (
                      <span className="ml-1.5 chip chip-accent text-[10px]">agent's pick</span>
                    ) : null}
                    {opt.tradeoff ? (
                      <span className="block text-[12px] text-[var(--color-fg-2)] mt-0.5">
                        {opt.tradeoff}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      {mode === "custom" || responseType === "free" ? (
        <div>
          <label
            htmlFor="agent-decision-custom"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            {responseType === "free" ? "your answer" : "custom answer"}
          </label>
          <textarea
            id="agent-decision-custom"
            className="textarea text-[13.5px] leading-relaxed min-h-[80px]"
            placeholder="describe what you'd prefer, in your own words…"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
          />
        </div>
      ) : null}

      {mode !== "agent" ? (
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] leading-snug">
          submitting an override resurfaces the work as a ready follow-up task (or, on a
          github-backed project, a linked follow-up issue) carrying your answer — it joins the queue
          like any other task instead of silently closing.
        </p>
      ) : null}

      {error ? (
        <div className="text-[12.5px] text-[var(--color-verdict-trashed)]">{error}</div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary w-full"
        onClick={submit}
        disabled={!canSubmit || isSubmitting}
      >
        {isSubmitting ? "submitting…" : submitLabel}
      </button>
    </div>
  );
}

interface ModeTabsProps {
  mode: "agent" | "options" | "custom";
  setMode: (mode: "agent" | "options" | "custom") => void;
  responseType: "single" | "multi" | "free";
  hasOptions: boolean;
  // Auto-ratified decisions hide the ratify tab — already ratified.
  showAgentTab: boolean;
}

function ModeTabs({ mode, setMode, responseType, hasOptions, showAgentTab }: ModeTabsProps) {
  // free-mode + no options ⇒ collapse to just "agent" / "custom"; the
  // "options" tab is meaningless without a closed set.
  const showOptionsTab = hasOptions && responseType !== "free";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {showAgentTab ? (
        <ModeChip
          active={mode === "agent"}
          onClick={() => setMode("agent")}
          label="agent's choice"
        />
      ) : null}
      {showOptionsTab ? (
        <ModeChip
          active={mode === "options"}
          onClick={() => setMode("options")}
          label={responseType === "multi" ? "pick subset" : "pick different option"}
        />
      ) : null}
      <ModeChip
        active={mode === "custom"}
        onClick={() => setMode("custom")}
        label="custom answer"
      />
    </div>
  );
}

function ModeChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "chip text-[11px]",
        active ? "chip-accent" : "hover:border-[var(--color-line-bright)]",
      )}
    >
      {label}
    </button>
  );
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
