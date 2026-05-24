import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, GitBranch, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
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
    today: OpsUsageBucket & { pctOfDailyUsdCap: number | null };
    rolling5h: OpsUsageBucket & { pctOfSessionTokensCap: number | null };
    rolling7d: OpsUsageBucket & { pctOfWeeklyTokensCap: number | null };
    caps: {
      sessionTokens: number | null;
      weeklyTokens: number | null;
      dailyUsd: number | null;
    };
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
  if (status === "usage_capped" || status === "deferred") return "chip-decompose";
  return "";
}

export function Ops() {
  const snap = useQuery({
    queryKey: ["ops.snapshot"],
    queryFn: () => trpc.ops.snapshot.query() as unknown as Promise<OpsSnapshot>,
    refetchInterval: 30_000,
  });

  useScopedChannel({ kind: "ops", id: "" }, { invalidate: [["ops.snapshot"]] });

  if (snap.isLoading) {
    return (
      <div className="space-y-3">
        <div className="skel h-6 w-40 mb-3" />
        <div className="skel h-32 w-full" />
      </div>
    );
  }
  if (!snap.data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        couldn't load ops snapshot.
      </div>
    );
  }

  const { running, queued, recent, sessions, usage } = snap.data;

  return (
    <div className="space-y-4 pb-4">
      <header className="surface p-4">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[var(--color-accent)]" />
          <h1 className="display text-[20px] leading-none">ops</h1>
        </div>
        <p className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mt-2">
          live state · today's usage · recent activity
        </p>
      </header>

      {/* Usage meters */}
      <section>
        <SectionHeader title="usage" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <UsageCard
            label="today"
            value={fmtCost(usage.today.totalCostUsd)}
            sub={`↑${fmtTokens(usage.today.inputTokens)} ↓${fmtTokens(usage.today.outputTokens)}`}
            pct={usage.today.pctOfDailyUsdCap}
            cap={usage.caps.dailyUsd != null ? `cap $${usage.caps.dailyUsd.toFixed(2)}/day` : null}
          />
          <UsageCard
            label="rolling 5h"
            value={fmtTokens(usage.rolling5h.inputTokens + usage.rolling5h.outputTokens)}
            sub={`↑${fmtTokens(usage.rolling5h.inputTokens)} ↓${fmtTokens(usage.rolling5h.outputTokens)} · ${fmtCost(usage.rolling5h.totalCostUsd)}`}
            pct={usage.rolling5h.pctOfSessionTokensCap}
            cap={
              usage.caps.sessionTokens != null
                ? `cap ${fmtTokens(usage.caps.sessionTokens)} tok/5h`
                : null
            }
          />
          <UsageCard
            label="rolling 7d"
            value={fmtTokens(usage.rolling7d.inputTokens + usage.rolling7d.outputTokens)}
            sub={`↑${fmtTokens(usage.rolling7d.inputTokens)} ↓${fmtTokens(usage.rolling7d.outputTokens)} · ${fmtCost(usage.rolling7d.totalCostUsd)}`}
            pct={usage.rolling7d.pctOfWeeklyTokensCap}
            cap={
              usage.caps.weeklyTokens != null
                ? `cap ${fmtTokens(usage.caps.weeklyTokens)} tok/wk`
                : null
            }
          />
        </div>
        {usage.caps.sessionTokens == null &&
        usage.caps.weeklyTokens == null &&
        usage.caps.dailyUsd == null ? (
          <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2 px-1">
            no caps configured —{" "}
            <Link to="/settings" className="text-[var(--color-accent)] underline">
              set them in settings
            </Link>{" "}
            to see % meters.
          </p>
        ) : null}
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
    </div>
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
  value,
  sub,
  pct,
  cap,
}: {
  label: string;
  value: string;
  sub: string;
  pct: number | null;
  cap: string | null;
}) {
  return (
    <div className="surface p-3">
      <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div className="display text-[22px] mt-1 tabular-nums">
        {pct != null ? `${Math.round(pct)}%` : value}
      </div>
      {pct != null ? (
        <>
          <div className="mt-2 h-1.5 bg-[var(--color-bg-2)] rounded-sm overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)]"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] mt-1.5">
            {value} · {sub}
          </div>
        </>
      ) : (
        <div className="mono text-[10.5px] tabular-nums text-[var(--color-fg-3)] mt-1">{sub}</div>
      )}
      {cap ? <div className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">{cap}</div> : null}
    </div>
  );
}
