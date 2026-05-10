import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import {
  chipLabel,
  fmtCost,
  fmtDurationMs,
  fmtTokens,
  type MetricsAggregate,
} from "../lib/metrics-format.ts";
import { trpc } from "../lib/trpc.ts";

interface SummaryRow extends MetricsAggregate {
  ownerKind?: string;
  projectId?: string | null;
}

interface SummaryResponse {
  totals: MetricsAggregate;
  byProject: Array<MetricsAggregate & { projectId: string | null }>;
  byOwnerKind: Array<MetricsAggregate & { ownerKind: string }>;
}

const OWNER_KIND_LABEL: Record<string, string> = {
  run: "code-changing runs",
  audit: "audits (read-only)",
  audit_exec: "audits (exec)",
  plan_iteration: "plan iteration",
  triage: "triage",
  audit_promote: "audit → promote bridge",
  audit_comment: "audit follow-ups",
};

export function Metrics() {
  const summary = useQuery({
    queryKey: ["metrics.summary"],
    queryFn: () => trpc.metrics.summary.query() as unknown as Promise<SummaryResponse>,
    refetchInterval: 30_000,
  });

  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () =>
      trpc.projects.list.query() as unknown as Promise<Array<{ id: string; name: string }>>,
  });

  if (summary.isLoading) {
    return (
      <div className="surface p-4 mono text-[12px] text-[var(--color-fg-3)]">loading metrics…</div>
    );
  }
  if (summary.isError) {
    return (
      <div className="surface p-4 text-[13px]">
        <div className="display text-[var(--color-verdict-trashed)] mb-1">metrics unavailable</div>
        <div className="mono text-[11px] text-[var(--color-fg-3)]">
          {(summary.error as Error).message}
        </div>
      </div>
    );
  }

  const data = summary.data;
  if (!data) return null;

  const projectName = new Map(projects.data?.map((p) => [p.id, p.name]) ?? []);
  const sortedProjects = [...data.byProject].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  const sortedKinds = [...data.byOwnerKind].sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return (
    <div className="space-y-3 pb-4 md:max-w-5xl md:mx-auto">
      <header className="surface p-4">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> settings
        </Link>
        <h1 className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2">
          runtime metrics
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
          Cost and token usage across every Claude invocation Heimdall has made.
        </p>
      </header>

      <section>
        <SectionHeader title="totals" />
        <div className="surface p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="cost" value={fmtCost(data.totals.totalCostUsd)} />
          <Stat
            label="tokens"
            value={fmtTokens(data.totals.inputTokens + data.totals.outputTokens)}
          />
          <Stat label="invocations" value={String(data.totals.invocations)} />
          <Stat label="wall time" value={fmtDurationMs(data.totals.durationMs)} />
        </div>
        <div className="surface mt-2 px-4 py-3 mono text-[10.5px] text-[var(--color-fg-3)] grid grid-cols-2 gap-2 sm:grid-cols-4">
          <span>in: {fmtTokens(data.totals.inputTokens)}</span>
          <span>out: {fmtTokens(data.totals.outputTokens)}</span>
          <span>cache-create: {fmtTokens(data.totals.cacheCreationTokens)}</span>
          <span>cache-read: {fmtTokens(data.totals.cacheReadTokens)}</span>
        </div>
      </section>

      <section>
        <SectionHeader title="by project" />
        {sortedProjects.length === 0 ? (
          <div className="surface px-3 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            no project-attributed invocations yet.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {sortedProjects.map((row) => (
              <ProjectRow
                key={row.projectId ?? "unattributed"}
                row={row}
                name={
                  row.projectId
                    ? (projectName.get(row.projectId) ?? row.projectId)
                    : "(unattributed)"
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title="by owner kind" />
        {sortedKinds.length === 0 ? (
          <div className="surface px-3 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            no recorded invocations yet.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {sortedKinds.map((row) => (
              <KindRow
                key={row.ownerKind}
                label={OWNER_KIND_LABEL[row.ownerKind] ?? row.ownerKind}
                row={row}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </span>
      <span className="display text-[20px] leading-tight text-[var(--color-fg)] tabular-nums">
        {value}
      </span>
    </div>
  );
}

function ProjectRow({ row, name }: { row: SummaryRow; name: string }) {
  const tokens = row.inputTokens + row.outputTokens;
  const inner =
    row.projectId !== null && row.projectId !== undefined ? (
      <Link
        to={`/projects/${row.projectId}`}
        className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
      >
        <RowBody
          name={name}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </Link>
    ) : (
      <div className="px-3 py-2.5">
        <RowBody
          name={name}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </div>
    );
  return <li>{inner}</li>;
}

function KindRow({ row, label }: { row: SummaryRow; label: string }) {
  const tokens = row.inputTokens + row.outputTokens;
  return (
    <li>
      <div className="px-3 py-2.5">
        <RowBody
          name={label}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </div>
    </li>
  );
}

function RowBody({
  name,
  cost,
  tokens,
  invocations,
}: {
  name: string;
  cost: number;
  tokens: number;
  invocations: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[13.5px] text-[var(--color-fg)] truncate flex-1">{name}</span>
      <span className="mono text-[11px] text-[var(--color-fg-2)] tabular-nums">
        {fmtCost(cost)}
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[68px] text-right">
        {fmtTokens(tokens)} tok
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[44px] text-right">
        ×{invocations}
      </span>
    </div>
  );
}

// Re-export for convenience so other components can render compact metric chips.
export { chipLabel };
