import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, GitBranch, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { AutonomyMetrics } from "../components/autonomy-metrics.tsx";
import { AutonomyHistory } from "../components/autonomy-panel.tsx";
import { trpc } from "../lib/trpc.ts";
import { useScopedChannel } from "../lib/use-channel.ts";

interface OpsRun {
  id: string;
  status: string;
  taskId: string | null;
  startedAt: number;
  durationMs?: number;
  iteration: number;
  projectId: string;
  projectSlug: string;
  projectName: string;
}

interface OpsQueued {
  id: string;
  taskId: string | null;
  startedAt: number;
  projectId: string;
  projectSlug: string;
}

interface OpsRecent {
  id: string;
  status: string;
  taskId: string | null;
  endedAt: number | null;
  projectId: string;
  projectSlug: string;
}

interface OpsSession {
  id: string;
  mode: string;
  startedAt: number;
  projectId: string;
  projectSlug: string;
}

interface OpsUsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

interface OpsSnapshot {
  ts: number;
  running: OpsRun[];
  queued: OpsQueued[];
  recent: OpsRecent[];
  sessions: OpsSession[];
  usage: {
    today: OpsUsageBucket;
    thisWeek: OpsUsageBucket;
    thisMonth: OpsUsageBucket;
  };
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

function fmtCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function statusChip(status: string): string {
  if (status === "completed") return "chip-greenlit";
  if (status === "failed" || status === "blocked" || status === "aborted") return "chip-trashed";
  if (status === "running" || status === "queued") return "chip-accent";
  if (status === "usage_capped" || status === "deferred" || status === "needs_review")
    return "chip-decompose";
  return "";
}

export function Ops() {
  const snap = useQuery({
    queryKey: ["ops.snapshot"],
    queryFn: () => trpc.ops.snapshot.query() as unknown as Promise<OpsSnapshot>,
    refetchInterval: 30_000,
  });

  useScopedChannel({ kind: "ops", id: "" }, { invalidate: [["ops.snapshot"]] });

  return (
    <div className="space-y-4 pb-4">
      <header className="surface p-4">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[var(--color-accent)]" />
          <h1 className="display text-[20px] leading-none">ops</h1>
        </div>
        <p className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mt-2">
          live state · spend · recent activity
        </p>
      </header>

      {/* Historical autonomy / throughput charts (read-only, ADR-013). */}
      <AutonomyMetrics />

      {/* What the autonomy machinery did unattended (read-only, ADR-016). */}
      <AutonomyHistory limit={50} />

      {/* Live snapshot block — loads independently of the charts above. */}
      {snap.isLoading ? (
        <div className="surface p-4">
          <div className="skel h-6 w-40 mb-3" />
          <div className="skel h-32 w-full" />
        </div>
      ) : !snap.data ? (
        <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
          couldn't load ops snapshot.
        </div>
      ) : (
        <OpsLive data={snap.data} />
      )}
    </div>
  );
}

function OpsLive({ data }: { data: OpsSnapshot }) {
  const { running, queued, recent, sessions, usage } = data;
  return (
    <>
      {/* Usage windows: today / this week / this month, calendar-aligned. */}
      <section>
        <SectionHeader title="usage" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <UsageCard label="today" bucket={usage.today} hint="since local midnight" />
          <UsageCard label="this week" bucket={usage.thisWeek} hint="since monday 00:00" />
          <UsageCard
            label="this month"
            bucket={usage.thisMonth}
            hint="since the 1st · resets with billing"
          />
        </div>
      </section>

      {/* Running runs */}
      <section>
        <SectionHeader title="running" count={running.length} />
        {running.length === 0 ? (
          <p className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">idle.</p>
        ) : (
          <div className="surface divide-y divide-[var(--color-line)]">
            {running.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${r.projectId}/runs/${r.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <span className="chip chip-accent">{r.status}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">
                    <span className="text-[var(--color-fg)]">{r.projectName}</span>
                    <span className="text-[var(--color-fg-3)] mono text-[11px] ml-2">
                      · {r.taskId ?? "ad-hoc"}
                    </span>
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {r.id.slice(0, 8)} · iter {r.iteration}
                  </div>
                </div>
                <div className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] shrink-0">
                  <Clock size={10} className="inline mr-1" />
                  {fmtDuration(r.durationMs ?? Date.now() - r.startedAt)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Queued runs */}
      {queued.length > 0 ? (
        <section>
          <SectionHeader title="queued" count={queued.length} />
          <div className="surface divide-y divide-[var(--color-line)]">
            {queued.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${r.projectId}/runs/${r.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <span className="chip">queued</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">
                    <span className="text-[var(--color-fg)]">{r.projectSlug}</span>
                    <span className="text-[var(--color-fg-3)] mono text-[11px] ml-2">
                      · {r.taskId ?? "ad-hoc"}
                    </span>
                  </div>
                </div>
                <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  {fmtAgo(r.startedAt)}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Active intervene sessions */}
      {sessions.length > 0 ? (
        <section>
          <SectionHeader title="sessions" count={sessions.length} />
          <div className="surface divide-y divide-[var(--color-line)]">
            {sessions.map((s) => (
              <Link
                key={s.id}
                to={`/projects/${s.projectId}/sessions/${s.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <Terminal size={12} className="text-[var(--color-accent)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">{s.projectSlug}</div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {s.mode} · {s.id.slice(0, 8)}
                  </div>
                </div>
                <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                  {fmtAgo(s.startedAt)}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Recent terminal activity (24h) */}
      <section>
        <SectionHeader title="recent · 24h" count={recent.length} />
        {recent.length === 0 ? (
          <p className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">
            nothing finished in the last 24h.
          </p>
        ) : (
          <div className="surface divide-y divide-[var(--color-line)]">
            {recent.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${r.projectId}/runs/${r.id}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
              >
                <span className={`chip ${statusChip(r.status)}`}>{r.status}</span>
                <GitBranch size={11} className="text-[var(--color-fg-3)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">
                    <span className="text-[var(--color-fg)]">{r.projectSlug}</span>
                    <span className="text-[var(--color-fg-3)] mono text-[11px] ml-2">
                      · {r.taskId ?? "ad-hoc"}
                    </span>
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {r.id.slice(0, 8)}
                  </div>
                </div>
                <div className="mono text-[10.5px] text-[var(--color-fg-3)] shrink-0">
                  {fmtAgo(r.endedAt)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
      {count != null ? (
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{count}</span>
      ) : null}
    </div>
  );
}

function UsageCard({
  label,
  bucket,
  hint,
}: {
  label: string;
  bucket: OpsUsageBucket;
  hint: string;
}) {
  return (
    <div className="surface p-3">
      <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div className="display text-[22px] mt-1 tabular-nums">{fmtCost(bucket.totalCostUsd)}</div>
      <div className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] mt-1.5">
        ↑{fmtTokens(bucket.inputTokens)} ↓{fmtTokens(bucket.outputTokens)}
      </div>
      <div className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">{hint}</div>
    </div>
  );
}
