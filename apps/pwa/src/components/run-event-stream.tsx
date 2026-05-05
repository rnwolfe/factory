import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useRunChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";
import { type RunEvent, RunEventRow } from "./run-event-row.tsx";

const MAX_EVENTS = 500;

interface PersistedEventRow {
  id: number;
  payload: RunEvent;
}

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
 */
export function RunEventStream({ runId }: { runId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [seeded, setSeeded] = useState(false);

  const persisted = useQuery({
    queryKey: ["runs.events", runId],
    queryFn: () => trpc.runs.events.query({ runId }) as unknown as Promise<PersistedEventRow[]>,
    enabled: runId.length > 0 && !seeded,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!persisted.data || seeded) return;
    const seed = persisted.data
      .map((row) => row.payload)
      .filter((p): p is RunEvent => Boolean(p))
      .slice(-MAX_EVENTS);
    setEvents(seed);
    setSeeded(true);
  }, [persisted.data, seeded]);

  useRunChannel(runId, [], {
    onEvent: (e) => {
      if (!e || typeof e !== "object") return;
      const ev = e as RunEvent & { channel?: string };
      if (ev.channel !== "events") return;
      setEvents((cur) => {
        const next = [...cur, ev];
        if (next.length > MAX_EVENTS) {
          return next.slice(next.length - MAX_EVENTS);
        }
        return next;
      });
    },
  });

  if (!seeded && persisted.isLoading) {
    return (
      <div className="surface px-3 py-3 mono text-[11.5px] text-[var(--color-fg-3)]">
        loading run history…
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
        {events.map((e, i) => {
          const showIterBoundary = e.iteration !== undefined && e.iteration !== prevIteration;
          prevIteration = e.iteration;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream with no stable id
            <div key={i}>
              {showIterBoundary && i > 0 ? (
                <div className="run-event-iter-divider">— iteration {e.iteration} —</div>
              ) : null}
              <RunEventRow event={e} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
