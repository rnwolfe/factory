import { ArrowRight, MoreHorizontal, Trash2 } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { SourceIssueLink, sourceIssueLabel } from "./source-link.tsx";

export interface DecisionRow {
  id: string;
  kind:
    | "triage"
    | "tag_change"
    | "blocked_run"
    | "merge_failure"
    | "agent_decision"
    | "issue_intake"
    | "release_proposal"
    | "queue_empty"
    | "watch_insight";
  outcome: string;
  weightedScore: number | null;
  uncertainty: number | null;
  snoozedUntil?: number | null;
  createdAt: number;
  payload: {
    rationale?: string;
    title_suggestion?: string;
    clarifying_questions?: string[];
    decompose_questions?: Array<{
      question: string;
      blocking_axis?: string;
      expected_signal?: string;
    }>;
    what_would_change_verdict?: string;
    // blocked_run / merge_failure shape
    runId?: string;
    taskId?: string | null;
    summary?: string;
    questions?: string[];
    branch?: string;
    // blocked_run variants — distinguish the causes that all route
    // through this decision kind. Default (none set) = agent self-blocked.
    usageCapped?: boolean;
    failed?: boolean;
    // needs_review: agent exited cleanly with committed work but no
    // factory-status footer — branch holds reviewable commits, not merged.
    needsReview?: boolean;
    // merge_failure-only
    reason?: string;
    message?: string;
    // queue_empty shape
    projectSlug?: string;
    projectName?: string;
    // agent_decision shape
    kind?: "architectural" | "library" | "naming" | "scope" | "tradeoff";
    context?: string;
    decided?: string;
    options?: Array<{ title: string; tradeoff: string; chosen: boolean }>;
    reasoning?: string;
    // agent_decision override (task-064): operator pushed back, so the work
    // resurfaced as a follow-up task instead of closing.
    override?:
      | { kind: "single"; choice: string }
      | { kind: "multi"; choices: string[] }
      | { kind: "custom"; text: string };
    overrideAt?: number;
    resurfacedTaskId?: string | null;
    // issue_intake shape — an externally-filed GitHub issue offered for adoption
    number?: number;
    title?: string;
    author?: string;
    htmlUrl?: string;
    // release_proposal shape — a model-resolved version + rendered release body
    version?: string | null;
    body?: string;
    // watch_insight shape — an observation The Watch synthesized (ADR-010).
    // `title` + `number`/`author` above are shared field names; the watch-only
    // fields are below.
    observationId?: string;
    observationKind?:
      | "repeated-ritual"
      | "new-convention"
      | "correction-pattern"
      | "candidate-task"
      | "tooling-gap";
    detail?: string;
    proposal?: "adopt-as-task" | "record-as-convention" | "note-only";
    evidence?: Array<{ sourceId: string; sessionId: string }>;
    targetProjectSlug?: string | null;
    [k: string]: unknown;
  };
  ideaId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
}

interface Props {
  decision: DecisionRow;
  ideaText?: string | null;
  onAction: (action: "approve" | "park" | "trash" | "decompose" | "dismiss") => void;
  onOpen: () => void;
  snoozeControl?: React.ReactNode;
  index?: number;
}

const SWIPE_THRESHOLD = 96;

function verdictTone(outcome: string) {
  if (outcome.startsWith("greenlit")) return "chip-greenlit";
  if (outcome.startsWith("parked")) return "chip-parked";
  if (outcome.startsWith("trashed")) return "chip-trashed";
  if (outcome.startsWith("decompose")) return "chip-decompose";
  if (outcome === "blocked") return "chip-trashed";
  if (outcome.startsWith("merge:")) return "chip-trashed";
  return "";
}

function kindLabel(kind: DecisionRow["kind"], payload?: DecisionRow["payload"]): string {
  switch (kind) {
    case "triage":
      return "triage";
    case "tag_change":
      return "tag";
    case "blocked_run":
      // Same kind, several causes: framing follows the cause.
      if (payload?.needsReview) return "needs review";
      if (payload?.failed) return "failed run";
      if (payload?.usageCapped) return "usage cap";
      return "blocked run";
    case "merge_failure":
      return "merge failure";
    case "agent_decision":
      return "agent · decision";
    case "issue_intake":
      return "issue · intake";
    case "release_proposal":
      return "release";
    case "queue_empty":
      return "queue empty";
    case "watch_insight":
      return "watch · insight";
  }
}

/** Humanize a hyphenated observation/proposal token: "repeated-ritual" → "repeated ritual". */
function humanizeToken(token: string): string {
  return token.replace(/-/g, " ");
}

function uncertaintyLabel(u: number | null): string {
  if (u == null) return "—";
  if (u < 0.2) return "low";
  if (u < 0.4) return "med";
  return "high";
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function decisionProjectLabel(
  decision: Pick<DecisionRow, "kind" | "projectId" | "projectName">,
): string {
  if (decision.projectName) return decision.projectName;
  if (!decision.projectId) return decision.kind === "triage" ? "no project yet" : "no project";
  return `project ${decision.projectId.slice(0, 8)}`;
}

export function DecisionCard({
  decision,
  ideaText,
  onAction,
  onOpen,
  snoozeControl,
  index = 0,
}: Props) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startX.current = e.clientX;
    longPressTimer.current = setTimeout(() => setMenuOpen(true), 520);
    void e;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startX.current == null) return;
    const delta = e.clientX - startX.current;
    if (Math.abs(delta) > 6 && longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setDx(delta);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (dx > SWIPE_THRESHOLD) {
      onAction("approve");
    } else if (dx < -SWIPE_THRESHOLD) {
      onAction("dismiss");
    } else if (!menuOpen && Math.abs(dx) < 6) {
      // Quick tap with no swipe — open the detail page. We do this here
      // (rather than relying on the inner <button onClick={onOpen}>) so the
      // entire card surface is tappable and so pointer-capture quirks
      // don't swallow the click.
      const target = e.target as HTMLElement | null;
      const isInteractive = target?.closest("button, a, input, [data-card-skip-open]");
      if (!isInteractive) onOpen();
    }
    setDx(0);
    startX.current = null;
  };

  // Snap dx visually to threshold for clean affordance.
  const cappedDx = Math.max(-160, Math.min(160, dx));

  // Close long-press menu on outside tap.
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const fn = () => closeMenu();
    document.addEventListener("pointerdown", fn, { capture: true, once: true });
    return () => document.removeEventListener("pointerdown", fn, { capture: true });
  }, [menuOpen, closeMenu]);

  const isTriage = decision.kind === "triage";
  const isBlockedRun = decision.kind === "blocked_run";
  const isMergeFailure = decision.kind === "merge_failure";
  const isAgentDecision = decision.kind === "agent_decision";
  const isIssueIntake = decision.kind === "issue_intake";
  const isReleaseProposal = decision.kind === "release_proposal";
  const isQueueEmpty = decision.kind === "queue_empty";
  const isWatchInsight = decision.kind === "watch_insight";
  const issueNumber = typeof decision.payload.number === "number" ? decision.payload.number : null;
  const issueTitle = typeof decision.payload.title === "string" ? decision.payload.title : "";
  const issueHtmlUrl =
    typeof decision.payload.htmlUrl === "string" && decision.payload.htmlUrl.length > 0
      ? decision.payload.htmlUrl
      : null;

  const blockedHeadline = isBlockedRun
    ? (decision.payload.summary ??
      `run ${decision.payload.runId?.slice(0, 8) ?? ""} ${
        decision.payload.needsReview
          ? "needs review"
          : decision.payload.failed
            ? "failed"
            : "blocked"
      }${decision.payload.taskId ? ` on ${decision.payload.taskId}` : ""}`)
    : null;

  const mergeFailHeadline = isMergeFailure
    ? `merge to main failed${
        decision.payload.taskId ? ` for ${decision.payload.taskId}` : ""
      } — ${decision.payload.reason ?? "unknown"}`
    : null;

  const agentDecisionHeadline = isAgentDecision ? (decision.payload.summary ?? null) : null;

  const issueIntakeHeadline = isIssueIntake
    ? (sourceIssueLabel(issueNumber, issueTitle) ?? "GitHub issue")
    : null;

  const releaseHeadline = isReleaseProposal
    ? `release ${decision.payload.version ?? "(version pending)"}`
    : null;

  const queueEmptyHeadline =
    decision.kind === "queue_empty"
      ? `${decision.payload.projectName ?? decision.payload.projectSlug ?? "Project"} is out of runway — re-fill or archive`
      : null;

  const watchHeadline = isWatchInsight
    ? (decision.payload.title ?? "Insight from The Watch")
    : null;

  // The Watch's adopt verb is "adopt as task" only when the insight proposes a
  // task AND has a project to file it under; everything else is "acknowledge".
  const watchAdoptLabel =
    isWatchInsight && decision.payload.proposal === "adopt-as-task" && decision.projectId
      ? "adopt as task"
      : "acknowledge";

  const headline =
    blockedHeadline ??
    mergeFailHeadline ??
    agentDecisionHeadline ??
    issueIntakeHeadline ??
    releaseHeadline ??
    queueEmptyHeadline ??
    watchHeadline ??
    decision.payload.title_suggestion ??
    (ideaText ? ideaText.slice(0, 80) : decision.outcome);

  const score = decision.weightedScore != null ? decision.weightedScore.toFixed(1) : "—";

  return (
    <div
      className="relative overflow-hidden surface drop-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* swipe trays */}
      <div
        className="swipe-tray swipe-tray-approve"
        style={{ opacity: dx > 0 ? Math.min(1, dx / SWIPE_THRESHOLD) : 0 }}
      >
        <span>approve →</span>
      </div>
      <div
        className="swipe-tray swipe-tray-trash"
        style={{ opacity: dx < 0 ? Math.min(1, -dx / SWIPE_THRESHOLD) : 0 }}
      >
        <span>← dismiss</span>
      </div>

      <div
        ref={cardRef}
        className="relative bg-[var(--color-bg-1)] select-none"
        style={{
          transform: `translateX(${cappedDx}px)`,
          transition: dx === 0 ? "transform 180ms ease" : "none",
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
          setDx(0);
          startX.current = null;
        }}
      >
        <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className={cn("chip", verdictTone(decision.outcome))}>{decision.outcome}</span>
            <span className="chip">{kindLabel(decision.kind, decision.payload)}</span>
            <span
              className="chip max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap"
              title={decisionProjectLabel(decision)}
            >
              {decisionProjectLabel(decision)}
            </span>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
              · {timeAgo(decision.createdAt)} ago
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {snoozeControl}
            <button
              type="button"
              aria-label="more"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="text-[var(--color-fg-2)] hover:text-[var(--color-fg)] p-1 -mr-1"
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>

        {isIssueIntake ? (
          <div className="w-full text-left px-4 pb-3">
            <SourceIssueLink
              number={issueNumber}
              title={issueTitle}
              href={issueHtmlUrl}
              onClick={(e) => e.stopPropagation()}
              className="display block text-[17px] leading-snug line-clamp-2 break-words [overflow-wrap:anywhere]"
            />
          </div>
        ) : (
          <button type="button" onClick={onOpen} className="w-full text-left px-4 pb-3">
            {/*
              [contain:layout] is load-bearing on every line-clamped block here.
              WebKit/iOS Safari `-webkit-line-clamp` clips the element visually to
              N lines (offsetHeight ≈ 2 lines) but leaks its full intrinsic height
              (scrollHeight) into the parent's block flow, pushing siblings down by
              the un-clamped height — a huge empty gap on long summaries. (Blink is
              unaffected, so it only shows on iPhone.) Layout containment isolates
              that leak. The question <span> escapes the bug only because it's a
              flex item; these block-context clamps need the contain. Don't remove.
            */}
            <div className="display text-[17px] leading-snug text-[var(--color-fg)] line-clamp-2 [contain:layout]">
              {headline}
            </div>
            {decision.payload.rationale ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-2)] line-clamp-2 [contain:layout]">
                {decision.payload.rationale}
              </p>
            ) : null}
          </button>
        )}

        {isTriage ? (
          <div className="px-4 pb-3 flex items-center gap-2 mono text-[10.5px] text-[var(--color-fg-3)] uppercase tracking-[0.14em]">
            <span>score {score}</span>
            <span>·</span>
            <span>uncertainty {uncertaintyLabel(decision.uncertainty)}</span>
          </div>
        ) : isBlockedRun && decision.payload.questions && decision.payload.questions.length > 0 ? (
          <ul className="px-4 pb-3 space-y-1 text-[12.5px] text-[var(--color-fg-2)] leading-snug">
            {decision.payload.questions.slice(0, 3).map((q) => (
              <li key={q} className="flex gap-1.5">
                <span className="text-[var(--color-fg-3)] shrink-0">·</span>
                <span className="line-clamp-2">{q}</span>
              </li>
            ))}
          </ul>
        ) : isMergeFailure && decision.payload.message ? (
          <p className="px-4 pb-3 mono text-[11.5px] leading-snug text-[var(--color-fg-2)] line-clamp-3 [contain:layout]">
            {decision.payload.message}
          </p>
        ) : isAgentDecision ? (
          <div className="px-4 pb-3 space-y-1.5">
            <div className="flex items-center gap-1.5 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-3)]">
              <span>chose</span>
              <span className="text-[var(--color-accent)] normal-case tracking-normal">
                {decision.payload.decided ?? "(unspecified)"}
              </span>
              {decision.payload.kind ? <span>· {decision.payload.kind}</span> : null}
            </div>
            {decision.payload.context ? (
              <p className="text-[12.5px] leading-snug text-[var(--color-fg-2)] line-clamp-2 [contain:layout]">
                {decision.payload.context}
              </p>
            ) : null}
          </div>
        ) : isIssueIntake ? (
          <div className="px-4 pb-3 flex flex-wrap items-center gap-2 mono text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.14em]">
            <span>filed by @{decision.payload.author ?? "unknown"} on GitHub</span>
          </div>
        ) : isReleaseProposal ? (
          <div className="px-4 pb-3 mono text-[11px] text-[var(--color-fg-3)] uppercase tracking-[0.14em]">
            confirm to cut · model-determined version
          </div>
        ) : isWatchInsight ? (
          <div className="px-4 pb-3 space-y-2">
            {decision.payload.detail ? (
              <p className="text-[12.5px] leading-snug text-[var(--color-fg-2)] line-clamp-3 [contain:layout]">
                {decision.payload.detail}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {decision.payload.observationKind ? (
                <span className="chip text-[10.5px]">
                  {humanizeToken(decision.payload.observationKind)}
                </span>
              ) : null}
              {decision.payload.proposal ? (
                <span className="chip text-[10.5px]">
                  {humanizeToken(decision.payload.proposal)}
                </span>
              ) : null}
              <span className="mono text-[10.5px] text-[var(--color-fg-3)] uppercase tracking-[0.14em]">
                from {decision.payload.evidence?.length ?? 0} session
                {(decision.payload.evidence?.length ?? 0) === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        ) : null}

        {isTriage ? (
          <div className="grid grid-cols-4 border-t border-[var(--color-line)]">
            <ActionBtn
              label="approve"
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow
            />
            <ActionBtn label="park" onClick={() => onAction("park")} />
            <ActionBtn label="decompose" onClick={() => onAction("decompose")} />
            <ActionBtn label="trash" tone="danger" onClick={() => onAction("trash")} />
          </div>
        ) : isBlockedRun ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn label="retry" tone="primary" onClick={() => onAction("approve")} showArrow />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isMergeFailure ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn
              label="retry merge"
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow
            />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isAgentDecision ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn label="ratify" tone="primary" onClick={() => onAction("approve")} />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isIssueIntake ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn
              label="promote"
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow
            />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isReleaseProposal ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn
              label="cut release"
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow
            />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isQueueEmpty ? (
          <div className="grid grid-cols-1 border-t border-[var(--color-line)]">
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : isWatchInsight ? (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn
              label={watchAdoptLabel}
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow={watchAdoptLabel === "adopt as task"}
            />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        ) : (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn label="confirm" tone="primary" onClick={() => onAction("approve")} />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        )}
      </div>

      {menuOpen ? (
        <div className="absolute right-3 top-12 z-10 surface-2 shadow-[var(--shadow-elev)] py-1 min-w-[180px] text-[13px]">
          <MenuItem onClick={onOpen} label="see full rationale" />
          {decision.payload.what_would_change_verdict ? (
            <MenuItem onClick={onOpen} label="what would change verdict" />
          ) : null}
          <MenuItem
            onClick={() => onAction("dismiss")}
            label="dismiss"
            icon={<Trash2 size={13} />}
          />
        </div>
      ) : null}
    </div>
  );
}

function ActionBtn({
  label,
  tone,
  onClick,
  showArrow,
}: {
  label: string;
  tone?: "primary" | "danger";
  onClick: () => void;
  showArrow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-12 flex items-center justify-center gap-1 mono text-[11px] uppercase tracking-[0.14em] border-r border-[var(--color-line)] last:border-r-0",
        tone === "primary"
          ? "text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          : tone === "danger"
            ? "text-[var(--color-verdict-trashed)] hover:bg-[var(--color-verdict-trashed-soft)]"
            : "text-[var(--color-fg-1)] hover:bg-[var(--color-bg-2)]",
      )}
    >
      {label}
      {showArrow ? <ArrowRight size={12} /> : null}
    </button>
  );
}

function MenuItem({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-3)] flex items-center gap-2 text-[var(--color-fg-1)]"
    >
      {icon}
      {label}
    </button>
  );
}
