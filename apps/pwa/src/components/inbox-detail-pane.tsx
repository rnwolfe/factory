import { ArrowRight, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link } from "react-router-dom";
import type { AuditRow } from "./audit-card.tsx";
import { type DecisionRow, decisionProjectLabel } from "./decision-card.tsx";
import type { PlanRow } from "./plan-card.tsx";
import { SourceIssueLink } from "./source-link.tsx";

interface FeedbackInboxRow {
  id: string;
  vote: "up" | "down";
  body: string;
  contextHint: string | null;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  createdAt: number;
}

export type InboxDetailItem =
  | { kind: "decision"; row: DecisionRow; ideaText: string | null }
  | { kind: "plan"; row: PlanRow }
  | { kind: "audit"; row: AuditRow; projectName: string | null }
  | { kind: "feedback"; row: FeedbackInboxRow };

type DecisionAction = "approve" | "park" | "trash" | "decompose" | "dismiss";

interface Props {
  item: InboxDetailItem | null;
  onDecisionAction: (id: string, action: DecisionAction) => void;
}

export function InboxDetailPane({ item, onDecisionAction }: Props) {
  if (!item) {
    return (
      <div className="surface flex flex-col items-center justify-center text-center px-6 py-16 min-h-[280px]">
        <div className="display text-[15px] text-[var(--color-fg-2)] mb-1.5">nothing selected</div>
        <p className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          pick a card on the left
        </p>
      </div>
    );
  }

  switch (item.kind) {
    case "decision":
      return (
        <DecisionDetail
          row={item.row}
          ideaText={item.ideaText}
          onAction={(a) => onDecisionAction(item.row.id, a)}
        />
      );
    case "plan":
      return <PlanDetail row={item.row} />;
    case "audit":
      return <AuditDetail row={item.row} projectName={item.projectName} />;
    case "feedback":
      return <FeedbackDetail row={item.row} />;
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function DetailShell({
  chips,
  title,
  fullHref,
  children,
}: {
  chips: React.ReactNode;
  title: React.ReactNode;
  fullHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-1.5 mb-3">{chips}</div>
      <h2 className="display text-[18px] leading-snug text-[var(--color-fg)] mb-4 break-words [overflow-wrap:anywhere]">
        {title}
      </h2>
      <div className="space-y-3 text-[13px] leading-relaxed text-[var(--color-fg-1)]">
        {children}
      </div>
      <div className="hairline mt-5" />
      <Link
        to={fullHref}
        className="mt-4 mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-2)] hover:text-[var(--color-accent)] flex items-center gap-1.5"
      >
        open full view <ArrowRight size={12} />
      </Link>
    </div>
  );
}

function DecisionDetail({
  row,
  ideaText,
  onAction,
}: {
  row: DecisionRow;
  ideaText: string | null;
  onAction: (a: DecisionAction) => void;
}) {
  const summary = typeof row.payload?.summary === "string" ? row.payload.summary : null;
  const rationale = typeof row.payload?.rationale === "string" ? row.payload.rationale : null;
  const questions = Array.isArray(row.payload?.clarifying_questions)
    ? (row.payload.clarifying_questions as string[])
    : [];

  if (row.kind === "issue_intake") {
    const number = typeof row.payload?.number === "number" ? row.payload.number : null;
    const author = typeof row.payload?.author === "string" ? row.payload.author : null;
    const issueTitle = typeof row.payload?.title === "string" ? row.payload.title : "";
    const htmlUrl = typeof row.payload?.htmlUrl === "string" ? row.payload.htmlUrl : null;
    return (
      <DetailShell
        chips={
          <>
            <span className="chip">{kindLabel(row.kind)}</span>
            <span className="chip">{decisionProjectLabel(row)}</span>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
              {timeAgo(row.createdAt)} ago
            </span>
          </>
        }
        title={
          <SourceIssueLink
            number={number}
            title={issueTitle}
            href={htmlUrl}
            className="break-words [overflow-wrap:anywhere]"
          />
        }
        fullHref={`/decisions/${row.id}`}
      >
        <p className="text-[var(--color-fg-2)]">
          filed by @{author ?? "unknown"} on GitHub — promote to adopt it as a task (the comment
          thread becomes run context; runs comment back as the bot).
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={() => onAction("approve")}
            className="btn btn-primary flex-1 min-w-[120px]"
          >
            promote to task
          </button>
          <button type="button" onClick={() => onAction("dismiss")} className="btn">
            dismiss
          </button>
        </div>
      </DetailShell>
    );
  }

  if (row.kind === "release_proposal") {
    const version = typeof row.payload?.version === "string" ? row.payload.version : null;
    const body = typeof row.payload?.body === "string" ? row.payload.body : "";
    return (
      <DetailShell
        chips={
          <>
            <span className="chip">{kindLabel(row.kind)}</span>
            <span className="chip">{decisionProjectLabel(row)}</span>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
              {timeAgo(row.createdAt)} ago
            </span>
          </>
        }
        title={`release ${version ?? "(version pending)"}`}
        fullHref={`/decisions/${row.id}`}
      >
        <p className="text-[var(--color-fg-2)]">
          Version determined from the change set. Confirm to cut the release (bump + changelog +
          tag); the full notes are on the detail page.
        </p>
        {body ? (
          <pre className="mono text-[12px] leading-relaxed text-[var(--color-fg-2)] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {body.slice(0, 1200)}
            {body.length > 1200 ? "\n…" : ""}
          </pre>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={() => onAction("approve")}
            className="btn btn-primary flex-1 min-w-[120px]"
          >
            cut release
          </button>
          <button type="button" onClick={() => onAction("dismiss")} className="btn">
            dismiss
          </button>
        </div>
      </DetailShell>
    );
  }

  if (row.kind === "watch_insight") {
    const insightTitle = typeof row.payload?.title === "string" ? row.payload.title : null;
    const detail = typeof row.payload?.detail === "string" ? row.payload.detail : null;
    const observationKind =
      typeof row.payload?.observationKind === "string" ? row.payload.observationKind : null;
    const proposal = typeof row.payload?.proposal === "string" ? row.payload.proposal : null;
    const evidenceCount = Array.isArray(row.payload?.evidence) ? row.payload.evidence.length : 0;
    const adoptLabel =
      row.projectId && proposal === "adopt-as-task"
        ? "adopt as task"
        : row.projectId && proposal === "draft-feature-plan"
          ? "draft feature plan"
          : row.projectId && proposal === "groom-backlog"
            ? "close task"
            : "acknowledge";
    return (
      <DetailShell
        chips={
          <>
            <span className="chip">{kindLabel(row.kind)}</span>
            {observationKind ? (
              <span className="chip">{humanizeToken(observationKind)}</span>
            ) : null}
            <span className="chip">{decisionProjectLabel(row)}</span>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
              {timeAgo(row.createdAt)} ago
            </span>
          </>
        }
        title={insightTitle ?? "Insight from The Watch"}
        fullHref={`/decisions/${row.id}`}
      >
        {detail ? <p>{detail}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {proposal ? <span className="chip">{humanizeToken(proposal)}</span> : null}
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            from {evidenceCount} session{evidenceCount === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-[var(--color-fg-2)]">
          The Watch synthesized this from your out-of-band work — {adoptLabel} to act on it, or
          dismiss to clear it. Never a blocking review.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={() => onAction("approve")}
            className="btn btn-primary flex-1 min-w-[120px]"
          >
            {adoptLabel}
          </button>
          <button type="button" onClick={() => onAction("dismiss")} className="btn">
            dismiss
          </button>
        </div>
      </DetailShell>
    );
  }

  return (
    <DetailShell
      chips={
        <>
          <span className="chip">{kindLabel(row.kind)}</span>
          <span className="chip">{row.outcome}</span>
          <span className="chip">{decisionProjectLabel(row)}</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {timeAgo(row.createdAt)} ago
          </span>
        </>
      }
      title={row.payload?.title_suggestion ?? row.outcome}
      fullHref={`/decisions/${row.id}`}
    >
      {summary ? <p>{summary}</p> : null}
      {rationale ? (
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            rationale
          </div>
          <p>{rationale}</p>
        </div>
      ) : null}
      {ideaText ? (
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            captured idea
          </div>
          <p className="text-[var(--color-fg-2)]">{ideaText}</p>
        </div>
      ) : null}
      {questions.length > 0 ? (
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            clarifying questions
          </div>
          <ul className="list-disc pl-5 space-y-1 text-[var(--color-fg-2)]">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <button
          type="button"
          onClick={() => onAction("approve")}
          className="btn btn-primary flex-1 min-w-[120px]"
        >
          approve
        </button>
        <button type="button" onClick={() => onAction("decompose")} className="btn">
          decompose
        </button>
        <button type="button" onClick={() => onAction("park")} className="btn">
          park
        </button>
        <button type="button" onClick={() => onAction("trash")} className="btn btn-danger">
          trash
        </button>
        <button
          type="button"
          onClick={() => onAction("dismiss")}
          className="btn btn-ghost text-[12px] basis-full"
        >
          dismiss
        </button>
      </div>
    </DetailShell>
  );
}

function PlanDetail({ row }: { row: PlanRow }) {
  return (
    <DetailShell
      chips={
        <>
          <span className="chip">{row.kind.replace("_", " ")}</span>
          <span className={`chip ${row.status === "frozen" ? "chip-greenlit" : ""}`}>
            {row.status}
          </span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {timeAgo(row.updatedAt)} ago
          </span>
        </>
      }
      title={row.goal}
      fullHref={`/plans/${row.id}`}
    >
      {row.draft ? (
        <pre className="mono text-[12px] leading-relaxed text-[var(--color-fg-2)] whitespace-pre-wrap break-words max-h-[420px] overflow-y-auto">
          {row.draft.slice(0, 1600)}
          {row.draft.length > 1600 ? "\n…" : ""}
        </pre>
      ) : (
        <p className="text-[var(--color-fg-3)]">draft is empty</p>
      )}
    </DetailShell>
  );
}

function AuditDetail({ row, projectName }: { row: AuditRow; projectName: string | null }) {
  const findings = parseFindings(row.findings);
  const counts = countSeverity(findings);

  return (
    <DetailShell
      chips={
        <>
          <span className="chip">{row.skillName}</span>
          <span className={`chip ${row.status === "completed" ? "chip-greenlit" : ""}`}>
            {row.status}
          </span>
          {projectName ? <span className="chip">{projectName}</span> : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {timeAgo(row.completedAt ?? row.startedAt)} ago
          </span>
        </>
      }
      title={`${row.skillName} · ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
      fullHref={`/projects/${row.projectId}/audits/${row.id}`}
    >
      {findings.length > 0 ? (
        <div className="grid grid-cols-4 gap-2 mb-2">
          <SeverityTile label="critical" count={counts.critical} tone="trashed" />
          <SeverityTile label="major" count={counts.major} tone="parked" />
          <SeverityTile label="minor" count={counts.minor} />
          <SeverityTile label="enh" count={counts.enhancement} />
        </div>
      ) : (
        <p className="text-[var(--color-fg-2)]">no findings</p>
      )}
      {findings.slice(0, 3).map((f) => (
        <div key={f.id} className="border-l-2 border-[var(--color-line)] pl-3">
          <div className="text-[12.5px] text-[var(--color-fg-1)]">{f.title}</div>
          {f.filePath ? (
            <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
              {f.filePath}
              {f.line ? `:${f.line}` : ""}
            </div>
          ) : null}
        </div>
      ))}
      {findings.length > 3 ? (
        <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
          + {findings.length - 3} more — see full report
        </p>
      ) : null}
    </DetailShell>
  );
}

function FeedbackDetail({ row }: { row: FeedbackInboxRow }) {
  return (
    <DetailShell
      chips={
        <>
          <span className="chip flex items-center gap-1.5">
            {row.vote === "up" ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
            feedback
          </span>
          {row.contextHint ? <span className="chip">{row.contextHint}</span> : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {timeAgo(row.createdAt)} ago
          </span>
        </>
      }
      title={row.body.split("\n")[0] ?? "feedback"}
      fullHref={`/feedback/${row.id}`}
    >
      <p className="whitespace-pre-wrap">{row.body}</p>
    </DetailShell>
  );
}

function SeverityTile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone?: "trashed" | "parked";
}) {
  const accent =
    tone === "trashed"
      ? "text-[var(--color-verdict-trashed)]"
      : tone === "parked"
        ? "text-[var(--color-verdict-parked)]"
        : "text-[var(--color-fg-1)]";
  return (
    <div className="surface px-2 py-2 text-center">
      <div className={`display text-[18px] tabular-nums ${accent}`}>{count}</div>
      <div className="mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </div>
    </div>
  );
}

interface Finding {
  id: string;
  severity: "critical" | "major" | "minor" | "enhancement";
  title: string;
  filePath: string | null;
  line: number | null;
}

function parseFindings(raw: string | null): Finding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is Finding => typeof f?.id === "string");
  } catch {
    return [];
  }
}

function countSeverity(findings: Finding[]) {
  return findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    },
    { critical: 0, major: 0, minor: 0, enhancement: 0 } as Record<Finding["severity"], number>,
  );
}

function kindLabel(kind: DecisionRow["kind"]): string {
  switch (kind) {
    case "triage":
      return "triage";
    case "tag_change":
      return "tag";
    case "blocked_run":
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

/** Humanize a hyphenated observation/proposal token: "tooling-gap" → "tooling gap". */
function humanizeToken(token: string): string {
  return token.replace(/-/g, " ");
}
