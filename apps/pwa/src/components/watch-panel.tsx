/**
 * WatchPanel — read-only observability for The Watch's out-of-band synthesis
 * loop (ADR-010). The Watch scans the operator's out-of-band sessions on a
 * cadence and synthesizes observations; today those only surface as inbox
 * cards (and note-only ones never surface at all). This panel makes the LOOP
 * itself observable: cadence + last scan, per-source scan cursors, the
 * observation funnel, and the last 20 observations — including note-only ones
 * that never became inbox cards.
 *
 * Strictly awareness, never action (VISION — "not a second inbox"): no links,
 * no mutations. Consumes `watch.status` (fully typed via the tRPC client).
 * Empty/zero degrades to a quiet placeholder — the dev DB usually has no Watch
 * rows until the daemon's synthesis job has run.
 */

import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { trpc } from "../lib/trpc.ts";

/** The `watch.status` payload, kept in lockstep with the tRPC router via inference. */
export type WatchStatus = Awaited<ReturnType<typeof trpc.watch.status.query>>;

// ── relative-time formatter (mirrors ops.tsx fmtAgo; no shared lib helper) ───

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── presentation maps (labels/colors; existence driven by the API) ──────────

const STATUS_CHIP: Record<string, string> = {
  pending: "",
  surfaced: "chip-accent",
  adopted: "chip-greenlit",
  dismissed: "chip-trashed",
  superseded: "chip-decompose",
};

const FUNNEL_ORDER = ["pending", "surfaced", "adopted", "dismissed", "superseded"] as const;

// ── small UI atoms (match autonomy-metrics.tsx / ops.tsx) ───────────────────

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="surface-2 px-2.5 py-1.5 flex items-center gap-2">
      <span className="mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-fg-3)]">
        {label}
      </span>
      <span className="mono tabular-nums text-[13px] text-[var(--color-fg)] leading-none">
        {value}
      </span>
    </div>
  );
}

function SourceRow({
  label,
  id,
  available,
  position,
  lastScanAt,
}: {
  label: string;
  id: string;
  available: boolean;
  position: string | null;
  lastScanAt: number | null;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span
        className={[
          "w-1.5 h-1.5 rounded-full shrink-0",
          available ? "bg-[var(--color-verdict-greenlit)]" : "bg-[var(--color-fg-3)]",
        ].join(" ")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-[var(--color-fg)] truncate">{label}</div>
        <div className="mono text-[10px] text-[var(--color-fg-3)] truncate">
          {id}
          {position ? ` · ${position}` : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div
          className={[
            "mono text-[9px] uppercase tracking-[0.12em]",
            available ? "text-[var(--color-fg-2)]" : "text-[var(--color-fg-3)]",
          ].join(" ")}
        >
          {available ? "available" : "unavailable"}
        </div>
        <div className="mono text-[10px] text-[var(--color-fg-3)] tabular-nums">
          {fmtAgo(lastScanAt)}
        </div>
      </div>
    </div>
  );
}

function ObservationRow({
  kind,
  proposal,
  status,
  title,
  targetProjectSlug,
}: {
  kind: string;
  proposal: string;
  status: string;
  title: string;
  targetProjectSlug: string | null;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-1.5 flex-wrap mb-1">
        <span className="chip">{kind}</span>
        <span className="chip">{proposal}</span>
        <span className={`chip ${STATUS_CHIP[status] ?? ""}`.trim()}>{status}</span>
        {targetProjectSlug ? (
          <span className="mono text-[10px] text-[var(--color-fg-3)] ml-auto truncate max-w-[40%]">
            {targetProjectSlug}
          </span>
        ) : null}
      </div>
      <div className="text-[13.5px] text-[var(--color-fg-1)] leading-snug">{title}</div>
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

// ── main ─────────────────────────────────────────────────────────────────────

export function WatchPanel() {
  const statusQ = useQuery({
    queryKey: ["watch.status"],
    queryFn: () => trpc.watch.status.query(),
    refetchInterval: 60_000,
  });

  return <WatchPanelView data={statusQ.data} isLoading={statusQ.isLoading} />;
}

/**
 * Pure presentational body — data in, markup out (no hooks). Lets the panel be
 * render-tested for empty / populated states without standing up a query
 * client (mirrors the prop-driven component tests elsewhere in the PWA).
 */
export function WatchPanelView({
  data,
  isLoading,
}: {
  data: WatchStatus | undefined;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <section className="space-y-3">
        <SectionHeader title="the watch" />
        <div className="surface p-4">
          <div className="skel h-5 w-44 mb-3" />
          <div className="skel h-24 w-full" />
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="space-y-3">
        <SectionHeader title="the watch" />
        <div className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">
          couldn't load The Watch status.
        </div>
      </section>
    );
  }

  const scannedAny = data.sources.some((s) => s.lastScanAt != null);
  const nothingYet = data.observations.total === 0 && !scannedAny;

  return (
    <section className="space-y-3">
      <SectionHeader title="the watch" />

      {/* Header line: cadence + last scan */}
      <div className="surface p-3 flex items-center gap-3 flex-wrap">
        <Eye size={14} className="text-[var(--color-accent)] shrink-0" />
        <span className="mono text-[11px] text-[var(--color-fg-1)]">
          synthesis: <span className="text-[var(--color-accent)]">{data.cadence}</span>
        </span>
        <div className="hairline flex-1 min-w-[12px]" />
        <span className="mono text-[10px] text-[var(--color-fg-3)]">
          last scan {fmtAgo(data.lastScanAt)}
        </span>
      </div>

      {nothingYet ? (
        <div className="surface px-3 py-6 text-center">
          <p className="mono text-[11.5px] text-[var(--color-fg-3)]">
            The Watch hasn't synthesized anything yet
          </p>
        </div>
      ) : (
        <>
          {/* Observation funnel */}
          <div>
            <SectionHeader title="observations" count={data.observations.total} />
            <div className="flex flex-wrap gap-1.5">
              <StatChip label="total" value={data.observations.total} />
              {FUNNEL_ORDER.map((k) => (
                <StatChip key={k} label={k} value={data.observations[k]} />
              ))}
            </div>
          </div>

          {/* Per-source scan cursors */}
          {data.sources.length > 0 ? (
            <div>
              <SectionHeader title="sources" count={data.sources.length} />
              <div className="surface divide-y divide-[var(--color-line)]">
                {data.sources.map((s) => (
                  <SourceRow
                    key={s.id}
                    id={s.id}
                    label={s.label}
                    available={s.available}
                    position={s.position}
                    lastScanAt={s.lastScanAt}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {/* Recent observations (incl. note-only ones that never hit the inbox) */}
          <div>
            <SectionHeader title="recent" count={data.recent.length} />
            {data.recent.length === 0 ? (
              <p className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">
                no observations recorded yet.
              </p>
            ) : (
              <div className="surface divide-y divide-[var(--color-line)]">
                {data.recent.map((o) => (
                  <ObservationRow
                    key={o.id}
                    kind={o.kind}
                    proposal={o.proposal}
                    status={o.status}
                    title={o.title}
                    targetProjectSlug={o.targetProjectSlug}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <p className="mono text-[9.5px] text-[var(--color-fg-3)] px-1">
        read-only · out-of-band synthesis loop · note-only observations shown here never reach the
        inbox
      </p>
    </section>
  );
}
