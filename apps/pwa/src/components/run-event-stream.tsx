import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { useRunChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { type RunEvent, RunEventRow } from "./run-event-row.tsx";

const MAX_EVENTS = 500;

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

function RunEventStreamInner({ runId }: { runId: string }) {
  const [events, setEvents] = useState<KeyedEvent[]>([]);
  const [seeded, setSeeded] = useState(false);
  const liveCounterRef = useRef(0);
  const pendingRef = useRef<KeyedEvent[]>([]);
  const flushScheduledRef = useRef(false);

  const persisted = useQuery({
    queryKey: ["runs.events", runId],
    queryFn: () => trpc.runs.events.query({ runId }) as unknown as Promise<PersistedEventRow[]>,
    enabled: runId.length > 0 && !seeded,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!persisted.data || seeded) return;
    const seed: KeyedEvent[] = persisted.data
      .filter((row): row is PersistedEventRow => Boolean(row?.payload))
      .map((row) => ({ id: `db:${row.id}`, ev: row.payload }))
      .slice(-MAX_EVENTS);
    setEvents(seed);
    setSeeded(true);
  }, [persisted.data, seeded]);

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

  if (!seeded && persisted.isLoading) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-fg-3)]">
        loading run history…
      </div>
    );
  }

  if (persisted.isError) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-verdict-trashed)]">
        couldn't load run history: {(persisted.error as Error).message}
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
