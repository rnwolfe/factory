import { useQuery } from "@tanstack/react-query";
import { chipLabel, type MetricsAggregate } from "../lib/metrics-format.ts";
import { trpc } from "../lib/trpc.ts";

type OwnerKind =
  | "run"
  | "audit"
  | "audit_exec"
  | "plan_iteration"
  | "triage"
  | "audit_promote"
  | "audit_comment";

interface OwnerProps {
  ownerKind: OwnerKind;
  ownerId: string;
  className?: string;
}

/**
 * Tiny inline mono chip rendering "$0.18 · 4.2k tok · 23s" for a single
 * Factory entity. Renders nothing while loading or when no metrics exist —
 * intended to be slipped into existing card footers without adding chrome.
 */
export function MetricsChip({ ownerKind, ownerId, className }: OwnerProps) {
  const q = useQuery({
    queryKey: ["metrics.forOwner", ownerKind, ownerId],
    queryFn: () =>
      trpc.metrics.forOwner.query({ ownerKind, ownerId }) as unknown as Promise<{
        totals: MetricsAggregate;
      }>,
    enabled: ownerId.length > 0,
    staleTime: 60_000,
  });
  const label = q.data ? chipLabel(q.data.totals) : null;
  if (!label) return null;
  return (
    <span
      className={
        className ?? "mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] whitespace-nowrap"
      }
    >
      {label}
    </span>
  );
}

interface AuditProps {
  auditId: string;
  className?: string;
}

/**
 * Audit-specific chip that sums across iteration + promote bridge + comment
 * follow-ups (all share the same audit id but different owner kinds).
 */
export function AuditMetricsChip({ auditId, className }: AuditProps) {
  const q = useQuery({
    queryKey: ["metrics.forAudit", auditId],
    queryFn: () =>
      trpc.metrics.forAudit.query({ auditId }) as unknown as Promise<{
        totals: MetricsAggregate;
      }>,
    enabled: auditId.length > 0,
    staleTime: 60_000,
  });
  const label = q.data ? chipLabel(q.data.totals) : null;
  if (!label) return null;
  return (
    <span
      className={
        className ?? "mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] whitespace-nowrap"
      }
    >
      {label}
    </span>
  );
}

interface ProjectProps {
  projectId: string;
  className?: string;
}

/** Per-project totals chip — used in the project detail header. */
export function ProjectMetricsChip({ projectId, className }: ProjectProps) {
  const q = useQuery({
    queryKey: ["metrics.project-totals", projectId],
    queryFn: () =>
      trpc.metrics.forProject.query({ projectId, recentLimit: 1 }) as unknown as Promise<{
        totals: MetricsAggregate;
      }>,
    enabled: projectId.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const label = q.data ? chipLabel(q.data.totals) : null;
  if (!label) return null;
  return (
    <span
      className={
        className ?? "mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] whitespace-nowrap"
      }
    >
      {label}
    </span>
  );
}
