import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

export function Settings() {
  const { token, clear } = useAuth();
  const ping = useQuery({
    queryKey: ["health.ping"],
    queryFn: () => trpc.health.ping.query(),
    refetchInterval: 5_000,
  });
  const rubrics = useQuery({
    queryKey: ["rubrics.list"],
    queryFn: () => trpc.rubrics.list.query(),
  });

  return (
    <div className="space-y-4">
      <Section title="connection">
        <Row label="server">
          <span className="mono text-[12px]">{location.host}</span>
        </Row>
        <Row label="status">
          {ping.isError ? (
            <span className="chip chip-trashed">offline</span>
          ) : ping.data ? (
            <span className="chip chip-greenlit">online</span>
          ) : (
            <span className="chip">probing…</span>
          )}
        </Row>
        <Row label="server time">
          <span className="mono text-[12px] text-[var(--color-fg-2)]">
            {ping.data ? new Date(ping.data.ts).toISOString().replace("T", " ").slice(0, 19) : "—"}
          </span>
        </Row>
      </Section>

      <Section title="auth">
        <Row label="token">
          <span className="mono text-[12px] text-[var(--color-fg-2)]">
            {token ? `…${token.slice(-6)}` : "—"}
          </span>
        </Row>
        <div className="px-3 pb-3">
          <button type="button" className="btn btn-danger w-full" onClick={clear}>
            forget token
          </button>
        </div>
      </Section>

      <Section title="agent">
        <Link
          to="/settings/prompts"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">prompts</span>
          <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
        </Link>
        <Link
          to="/metrics"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">runtime metrics</span>
          <MetricsTotalChip />
        </Link>
      </Section>

      <Section title="active rubric">
        {rubrics.data && rubrics.data.length > 0 ? (
          rubrics.data.map((r) => (
            <Row key={r.id} label={r.rubricKey}>
              <span className="mono text-[12px] text-[var(--color-fg-2)]">v{r.version}</span>
            </Row>
          ))
        ) : (
          <Row label="status">
            <span className="mono text-[12px] text-[var(--color-fg-3)]">no active rubric</span>
          </Row>
        )}
      </Section>

      <p className="px-2 text-[11px] mono text-[var(--color-fg-3)] leading-relaxed">
        rotate the token via <span className="text-[var(--color-fg-2)]">factoryd rotate-token</span>{" "}
        on your server, then forget &amp; re-paste here.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface">
      <div className="px-3 py-2 border-b border-[var(--color-line)] mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0">
      <span className="text-[13px] text-[var(--color-fg-1)]">{label}</span>
      {children}
    </div>
  );
}

function MetricsTotalChip() {
  const summary = useQuery({
    queryKey: ["metrics.summary"],
    queryFn: () =>
      trpc.metrics.summary.query() as unknown as Promise<{
        totals: { totalCostUsd: number; invocations: number };
      }>,
    refetchInterval: 60_000,
  });
  const cost = summary.data?.totals.totalCostUsd ?? 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[12px] tabular-nums text-[var(--color-fg-2)]">
        {cost > 0 ? `$${cost < 0.01 ? "<0.01" : cost.toFixed(2)}` : "—"}
      </span>
      <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
    </div>
  );
}
