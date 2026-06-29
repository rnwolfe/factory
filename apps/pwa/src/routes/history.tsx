import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { DecisionRow } from "../components/decision-card.tsx";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

interface HistoryRow extends DecisionRow {
  // `auto_ratified` (ADR-012): an agent_decision the agent made autonomously on
  // an autonomous-tier run, auto-ratified rather than surfaced. It's out of the
  // pending inbox but lives here in history, still overridable post-hoc.
  status: "pending" | "actioned" | "dismissed" | "auto_ratified";
  actionedAt: number | null;
}

type VerdictFilter = "all" | "parked" | "trashed" | "decomposed" | "approved" | "dismissed";

const FILTERS: ReadonlyArray<{ id: VerdictFilter; label: string }> = [
  { id: "all", label: "all" },
  { id: "parked", label: "parked" },
  { id: "approved", label: "approved" },
  { id: "decomposed", label: "decomposed" },
  { id: "trashed", label: "trashed" },
  { id: "dismissed", label: "dismissed" },
];

function matchesFilter(row: HistoryRow, filter: VerdictFilter): boolean {
  if (filter === "all") return true;
  if (filter === "dismissed") return row.status === "dismissed";
  if (filter === "approved") return row.outcome.startsWith("greenlit");
  return row.outcome.startsWith(filter);
}

export function History() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<VerdictFilter>("all");
  const history = useQuery({
    queryKey: ["decisions.history"],
    queryFn: () => trpc.decisions.history.query({ limit: 200 }) as unknown as Promise<HistoryRow[]>,
    refetchInterval: 30_000,
  });

  const restore = useMutation({
    mutationFn: (decisionId: string) => trpc.decisions.revert.mutate({ decisionId }),
    onMutate: async (decisionId) => {
      await qc.cancelQueries({ queryKey: ["decisions.history"] });
      const prev = qc.getQueryData<HistoryRow[]>(["decisions.history"]);
      qc.setQueryData<HistoryRow[]>(["decisions.history"], (rows) =>
        (rows ?? []).filter((r) => r.id !== decisionId),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["decisions.history"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["decisions.history"] });
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
    },
  });

  const all = history.data ?? [];
  const counts = countByFilter(all);
  const filtered = all.filter((row) => matchesFilter(row, filter));

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <header className="flex items-baseline justify-between px-1">
        <h1 className="display text-[18px] text-[var(--color-fg)]">history</h1>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          {all.length} actioned
        </span>
      </header>

      <div className="flex flex-wrap gap-1.5 px-1">
        {FILTERS.map((f) => {
          const count = counts[f.id];
          const active = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "chip text-[11.5px]",
                active ? "chip-working" : "hover:border-[var(--color-line-bright)]",
              )}
            >
              {f.label}
              {count > 0 ? (
                <span className="mono text-[10px] text-[var(--color-fg-3)] ml-1.5 tabular-nums">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="surface divide-y divide-[var(--color-line)]">
        {history.isLoading ? (
          <div className="px-3 py-4">
            <div className="skel h-4 w-2/3 mb-1.5" />
            <div className="skel h-3 w-1/3" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-[var(--color-fg-3)]">
            {filter === "all"
              ? "no actioned decisions yet — they'll show up here once you triage."
              : `no ${filter} decisions yet.`}
          </div>
        ) : (
          filtered.map((row) => (
            <HistoryListItem
              key={row.id}
              row={row}
              onRestore={() => restore.mutate(row.id)}
              restoring={restore.isPending && restore.variables === row.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

function HistoryListItem({
  row,
  onRestore,
  restoring,
}: {
  row: HistoryRow;
  onRestore: () => void;
  restoring: boolean;
}) {
  const ts = row.actionedAt ?? row.createdAt;
  const resurfaced = isResurfaced(row);
  // Auto-ratified, not (yet) overridden: the agent decided autonomously. Reads
  // as an "auto-decided" item the operator can still open to override.
  const autoRatified = row.status === "auto_ratified" && !resurfaced;
  const title =
    typeof row.payload?.title_suggestion === "string"
      ? row.payload.title_suggestion
      : // A resurfaced override (or an auto-decided agent_decision) reads best
        // by its decision summary, not the raw `decided: …` outcome.
        (resurfaced || autoRatified) && typeof row.payload?.summary === "string"
        ? row.payload.summary
        : row.outcome;
  const revertible = isRevertible(row);
  return (
    <Link to={`/decisions/${row.id}`} className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        {resurfaced ? (
          <span className="chip chip-decompose text-[10.5px]">resurfaced → open</span>
        ) : autoRatified ? (
          <span
            className="chip chip-working text-[10.5px]"
            title="the agent decided this autonomously — open to override"
          >
            auto-decided
          </span>
        ) : (
          <span className={cn("chip text-[10.5px]", verdictTone(row.outcome, row.status))}>
            {row.status === "dismissed" ? "dismissed" : row.outcome}
          </span>
        )}
        <span className="chip text-[10.5px]">{kindLabel(row.kind)}</span>
        <div className="ml-auto flex items-center gap-2">
          {revertible ? (
            <button
              type="button"
              onClick={(e) => {
                // Don't follow the parent <Link>; this is its own action.
                e.preventDefault();
                e.stopPropagation();
                if (!restoring) onRestore();
              }}
              disabled={restoring}
              className="btn btn-ghost text-[11px] !h-7 !px-2 !gap-1.5"
              aria-label="restore to inbox"
            >
              <RotateCcw size={11} />
              {restoring ? "restoring…" : "restore"}
            </button>
          ) : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{timeAgo(ts)} ago</span>
        </div>
      </div>
      <div className="text-[13.5px] text-[var(--color-fg-1)] line-clamp-2">{title}</div>
    </Link>
  );
}

/**
 * An overridden agent_decision: the operator pushed back, so the work
 * resurfaced as a follow-up task rather than closing. It reads as open work in
 * history, not a settled verdict (task-064).
 */
function isResurfaced(row: HistoryRow): boolean {
  return row.kind === "agent_decision" && row.payload?.override != null;
}

function isRevertible(row: HistoryRow): boolean {
  if (row.status === "dismissed") return true;
  if (row.status === "actioned") {
    return row.outcome.startsWith("parked") || row.outcome.startsWith("trashed");
  }
  return false;
}

function verdictTone(outcome: string, status: HistoryRow["status"]): string {
  if (status === "dismissed") return "";
  if (outcome.startsWith("greenlit")) return "chip-greenlit";
  if (outcome.startsWith("parked")) return "chip-parked";
  if (outcome.startsWith("trashed")) return "chip-trashed";
  if (outcome.startsWith("decompose")) return "chip-decompose";
  if (outcome === "blocked" || outcome.startsWith("merge:")) return "chip-trashed";
  return "";
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

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function countByFilter(rows: HistoryRow[]): Record<VerdictFilter, number> {
  const counts: Record<VerdictFilter, number> = {
    all: rows.length,
    parked: 0,
    trashed: 0,
    decomposed: 0,
    approved: 0,
    dismissed: 0,
  };
  for (const row of rows) {
    if (matchesFilter(row, "parked")) counts.parked += 1;
    if (matchesFilter(row, "trashed")) counts.trashed += 1;
    if (matchesFilter(row, "decomposed")) counts.decomposed += 1;
    if (matchesFilter(row, "approved")) counts.approved += 1;
    if (matchesFilter(row, "dismissed")) counts.dismissed += 1;
  }
  return counts;
}
