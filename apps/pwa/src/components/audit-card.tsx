import { Link } from "react-router-dom";
import { AuditMetricsChip } from "./metrics-chip.tsx";

export type AuditStatus = "running" | "completed" | "reviewed" | "approved" | "rejected" | "failed";

export interface AuditRow {
  id: string;
  projectId: string;
  skillName: string;
  skillVersion: string;
  status: AuditStatus;
  startedAt: number;
  completedAt: number | null;
  reviewedAt: number | null;
  snoozedUntil?: number | null;
  approvedAt: number | null;
  reportMarkdown: string | null;
  findings: string | null;
  approvedReportPath: string | null;
}

export interface AuditFinding {
  id: string;
  severity: "critical" | "major" | "minor" | "enhancement";
  title: string;
  body: string;
  filePath: string | null;
  line: number | null;
  promotedTo: { kind: "plan" | "task"; id: string } | null;
}

interface Props {
  audit: AuditRow;
  projectName?: string | null;
  index?: number;
  snoozeControl?: React.ReactNode;
  onOpen: () => void;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function parseFindings(raw: string | null): AuditFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditFinding[]) : [];
  } catch {
    return [];
  }
}

function findingHistogram(findings: AuditFinding[]): string {
  const counts = { critical: 0, major: 0, minor: 0, enhancement: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical}C`);
  if (counts.major) parts.push(`${counts.major}M`);
  if (counts.minor) parts.push(`${counts.minor}m`);
  if (counts.enhancement) parts.push(`${counts.enhancement}e`);
  return parts.join(" ") || "0";
}

export function AuditCard({ audit, projectName, index = 0, snoozeControl, onOpen }: Props) {
  const findings = parseFindings(audit.findings);
  const histogram = findingHistogram(findings);
  const ts = audit.completedAt ?? audit.startedAt;
  const reviewed = audit.status === "reviewed" || audit.status === "approved";
  return (
    <div
      className="surface drop-in border-l-2 border-[var(--color-line-bright)]"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
        <span className="chip">audit · {audit.skillName}</span>
        <span className="chip">{audit.status}</span>
        {audit.skillVersion ? (
          <Link
            to={`/projects/${audit.projectId}/code?tab=commits&ref=${encodeURIComponent(audit.skillVersion)}`}
            className="chip"
          >
            commit {audit.skillVersion.slice(0, 8)}
          </Link>
        ) : null}
        {findings.length > 0 ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-2)]">{histogram}</span>
        ) : null}
        <AuditMetricsChip
          auditId={audit.id}
          className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] ml-auto whitespace-nowrap"
        />
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">· {timeAgo(ts)} ago</span>
        {snoozeControl}
      </div>
      <button type="button" onClick={onOpen} className="w-full text-left">
        <div className="px-4 pb-3">
          <div className="display text-[17px] leading-snug text-[var(--color-fg)] line-clamp-2">
            {projectName ?? "audit"}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-3)]">
            {findings.length === 0
              ? reviewed
                ? "no findings."
                : "tap to review."
              : `${findings.length} finding${findings.length === 1 ? "" : "s"} — tap to review and promote.`}
          </p>
        </div>
      </button>
    </div>
  );
}
