import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { useRunChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { type RunEvent, RunEventRow } from "./run-event-row.tsx";

// Cap the structured-view buffer. 200 is plenty to represent the tail of a
// run; the raw [raw] toggle preserves the full xterm stream. Lower numbers
// help: each row is a flex container with several spans, and on a phone or
// even a busy laptop, mounting hundreds of rows at once costs measurable
// frame time on the navigation into a run page.
const MAX_EVENTS = 200;

interface PersistedEventRow {
  id: number;
  payload: RunEvent;
}

/**
 * Each event in the buffer carries a stable id so React's keyed reconciler
 * can preserve DOM nodes across slices and avoid re-running MarkdownBlock
 * on rows whose source didn't change. Persisted rows use the events table's
 * autoincrement id; live rows get a synthetic monotonic id minted on
 * arrival.
 */
interface KeyedEvent {
  id: string;
  ev: RunEvent;
}

/**
 * Memoized row — re-renders only when the event reference changes.
 * Without this, every slice from the buffer re-mounts every row, and on a
 * busy run the markdown parser runs hundreds of times per event arrival.
 */
const MemoRunEventRow = memo(RunEventRow, (prev, next) => prev.event === next.event);

/**
 * Structured event timeline for a run. Default view in `live-pane.tsx` —
 * the xterm raw byte stream stays as a `[raw]` toggle.
 *
 * Source of events:
 *   - On mount: seed from `runs.events` (DB-persisted log) so completed
 *     runs aren't blank when revisited.
 *   - Live: `useRunChannel` pushes new events via the scoped /ws/events
 *     subscription. Reconnects with backoff per the channel hook.
 *
 * Cap at 500 events so long sessions don't OOM the page; oldest roll off.
 *
 * Live arrivals are batched on `requestAnimationFrame` so a burst of text
 * events (long agent output) doesn't trigger setState-per-event and the
 * resulting render cascade. Without batching, a verbose run can freeze
 * the page by saturating the React scheduler.
 */
export function RunEventStream({ runId }: { runId: string }) {
  return (
    <ErrorBoundary label="run-event-stream">
      <RunEventStreamInner runId={runId} />
    </ErrorBoundary>
  );
}

const STUCK_LOADING_MS = 8000;

function RunEventStreamInner({ runId }: { runId: string }) {
  const [events, setEvents] = useState<KeyedEvent[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [stuck, setStuck] = useState(false);
  const liveCounterRef = useRef(0);
  const pendingRef = useRef<KeyedEvent[]>([]);
  const flushScheduledRef = useRef(false);

  const persisted = useQuery({
    queryKey: ["runs.events", runId],
    queryFn: ({ signal }) =>
      trpc.runs.events.query({ runId }, { signal }) as unknown as Promise<PersistedEventRow[]>,
    enabled: runId.length > 0 && !seeded,
    staleTime: Number.POSITIVE_INFINITY,
    // gcTime:0 — evict this entry from the React-Query cache as soon as the
    // component unmounts. Without this, an empty response cached on a first
    // visit (run just started, 0 events in DB) persists for the default 5-min
    // window. On the next navigation here, the stale [] is served synchronously,
    // the seed effect sets seeded=true with an empty buffer, and the query is
    // then disabled — so the run's actual persisted events never appear. Clearing
    // on unmount guarantees every page navigation triggers a fresh fetch.
    gcTime: 0,
    // refetchOnMount:"always" closes the race condition where gcTime:0 hasn't
    // fired its setTimeout(evict,0) before the component remounts (SPA nav is
    // synchronous; the eviction macro-task may fire after the new observer
    // subscribes). With "always", a background refetch is triggered even when
    // staleTime:Infinity would otherwise serve the not-yet-evicted cache entry.
    // The isFetching guard in the seed effect below prevents seeding with the
    // stale [] until the real network response arrives.
    refetchOnMount: "always",
    // Limit the implicit React-Query retry on stuck/failed network so we
    // don't pile up multi-megabyte requests on a slow connection.
    retry: 1,
    retryDelay: 2000,
  });

  // Surface a "stuck" UI after a few seconds so the operator isn't watching
  // a silent spinner forever. The query itself doesn't time out (no native
  // browser timeout on fetch), but we do show a refetch button and the
  // diagnostic that the request hasn't returned yet.
  useEffect(() => {
    if (!persisted.isLoading || seeded) {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), STUCK_LOADING_MS);
    return () => clearTimeout(t);
  }, [persisted.isLoading, seeded]);

  useEffect(() => {
    if (!persisted.data || seeded) return;
    // Don't seed from a stale empty cache while refetchOnMount:"always" has a
    // background fetch in flight. The stale [] was served before the eviction
    // timer (gcTime:0) fired; if we seed now we'd lock the query as disabled
    // (enabled:!seeded) before the real events arrive. Wait for isFetching to
    // clear — the network response will re-enter this effect with fresh data.
    if (persisted.data.length === 0 && persisted.isFetching) return;
    const seed: KeyedEvent[] = persisted.data
      .filter((row): row is PersistedEventRow => Boolean(row?.payload))
      .map((row) => ({ id: `db:${row.id}`, ev: row.payload }))
      .slice(-MAX_EVENTS);
    setEvents(seed);
    setSeeded(true);
  }, [persisted.data, seeded, persisted.isFetching]);

  useRunChannel(runId, [], {
    onEvent: (e) => {
      if (!e || typeof e !== "object") return;
      const ev = e as RunEvent & { channel?: string };
      if (ev.channel !== "events") return;

      // Batch via rAF so a torrent of text events doesn't flush a setState
      // per event. The pendingRef accumulates until the next frame, then we
      // fold them into the visible buffer in one update.
      liveCounterRef.current += 1;
      pendingRef.current.push({ id: `live:${liveCounterRef.current}`, ev });
      if (flushScheduledRef.current) return;
      flushScheduledRef.current = true;
      const flush = () => {
        flushScheduledRef.current = false;
        const batch = pendingRef.current;
        if (batch.length === 0) return;
        pendingRef.current = [];
        setEvents((cur) => {
          const merged =
            cur.length + batch.length > MAX_EVENTS
              ? [...cur.slice(cur.length + batch.length - MAX_EVENTS), ...batch]
              : [...cur, ...batch];
          // Ensure we never overflow — extra-defensive against bursts.
          if (merged.length > MAX_EVENTS) return merged.slice(merged.length - MAX_EVENTS);
          return merged;
        });
      };
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(flush);
      } else {
        // SSR / older runtime fallback. setTimeout(0) batches within a tick.
        setTimeout(flush, 0);
      }
    },
  });

  // Show loading while: initial fetch has no data yet (isLoading), OR a
  // background refetch is in-flight and the seed hasn't fired (isFetching +
  // no events). The latter prevents a "no events yet" flash during the brief
  // window between stale-cache-serve and the real network response.
  if (!seeded && (persisted.isLoading || (persisted.isFetching && events.length === 0))) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-fg-3)]">
        <div className="flex items-center justify-between gap-2">
          <span>loading run history…</span>
          {stuck ? (
            <button
              type="button"
              onClick={() => persisted.refetch()}
              className="chip text-[10.5px] hover:border-[var(--color-line-bright)]"
            >
              taking too long — retry
            </button>
          ) : null}
        </div>
        {stuck ? (
          <p className="mt-1.5 text-[var(--color-fg-3)]">
            the request hasn't returned in {Math.round(STUCK_LOADING_MS / 1000)}s. this can happen
            on slow networks for runs with lots of agent output. retry to refetch, or fall back to
            the [raw] log toggle above.
          </p>
        ) : null}
      </div>
    );
  }

  if (persisted.isError) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-verdict-trashed)]">
        <div className="flex items-center justify-between gap-2">
          <span>couldn't load run history: {(persisted.error as Error).message}</span>
          <button
            type="button"
            onClick={() => persisted.refetch()}
            className="chip text-[10.5px] hover:border-[var(--color-line-bright)]"
          >
            retry
          </button>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-fg-3)]">
        no events yet — waiting for the agent.
      </div>
    );
  }

  let prevIteration: number | undefined;
  return (
    <div className="run-event-stream surface p-0 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        <span>events</span>
        <span>· {events.length}</span>
      </div>
      <div className="run-event-list max-h-[60vh] overflow-y-auto">
        {events.map(({ id, ev }) => {
          const showIterBoundary = ev.iteration !== undefined && ev.iteration !== prevIteration;
          const wasFirst = prevIteration === undefined;
          prevIteration = ev.iteration;
          return (
            <div key={id}>
              {showIterBoundary && !wasFirst ? (
                <div className="run-event-iter-divider">— iteration {ev.iteration} —</div>
              ) : null}
              <MemoRunEventRow event={ev} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
