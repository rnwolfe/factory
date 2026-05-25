/**
 * Regression tests for the "empty events on run page revisit" bug.
 *
 * Root cause 1 (gcTime race): `staleTime: Infinity` on the `runs.events` query
 * meant that an empty response cached during a first visit (e.g., when the run
 * had just started and the events table was empty) could persist until the next
 * navigation. On that navigation the component received [] from cache, seeded
 * with nothing, set seeded=true, and disabled the query — so the real persisted
 * events were never fetched.
 * Fix: `gcTime: 0` evicts the cache on unmount, and `refetchOnMount: "always"`
 * triggers a background network fetch even if the not-yet-evicted [] entry is
 * still in cache (the eviction macro-task can race with the synchronous SPA
 * remount).
 *
 * Root cause 2 (isFetching race): even with gcTime:0, if the component remounts
 * before the eviction setTimeout fires, the stale [] is served synchronously
 * while isFetching=true. Without an isFetching guard the seed fired immediately
 * with [], set seeded=true, disabled the query, and the background fetch result
 * was discarded — leaving events permanently empty.
 * Fix: the seed effect now skips seeding when data.length===0 && isFetching,
 * waiting for the real network response before locking the seed state.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type React from "react";

// --------------------------------------------------------------------------
// Module mocks — must be declared before any import of the module under test.
// --------------------------------------------------------------------------

// Intercept the tRPC client so the component never makes real HTTP requests.
const eventsQueryFn = mock(async () => [] as PersistedRow[]);
mock.module("../../lib/trpc.ts", () => ({
  trpc: {
    runs: {
      events: { query: eventsQueryFn },
    },
  },
}));

// Suppress the WebSocket subscription — live events are not tested here.
mock.module("../../lib/channels.ts", () => ({
  useRunChannel: () => undefined,
}));

// --------------------------------------------------------------------------
// Types (inline to avoid importing from the component before mocks are set up)
// --------------------------------------------------------------------------
interface PersistedRow {
  id: number;
  payload: { kind: string; text?: string; iteration?: number };
}

// --------------------------------------------------------------------------
// The module under test — imported AFTER mock.module calls so the mock
// intercepts the dependency correctly.
// --------------------------------------------------------------------------
const { RunEventStream } = await import("../run-event-stream.tsx");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function Wrapper({ client, children }: { client: QueryClient; children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  eventsQueryFn.mockReset();
});

describe("RunEventStream — seed from persisted events", () => {
  test("renders persisted events on first mount without any WS message", async () => {
    eventsQueryFn.mockResolvedValueOnce([
      { id: 1, payload: { kind: "text", text: "hello from agent", iteration: 1 } },
      { id: 2, payload: { kind: "commit", iteration: 1 } },
    ]);

    const client = makeClient();
    const { container } = render(
      <Wrapper client={client}>
        <RunEventStream runId="run-seed-test" />
      </Wrapper>,
    );

    // Persisted events should appear before any WebSocket message arrives.
    await waitFor(
      () => {
        const html = container.innerHTML;
        if (!html.includes("hello from agent")) {
          throw new Error(`Expected "hello from agent" in DOM, got: ${html.slice(0, 500)}`);
        }
      },
      { timeout: 3000 },
    );
  });

  test("isFetching guard — stale empty cache does not seed before network response", async () => {
    const client = makeClient();
    const RUN_ID = "run-ifetching-guard-test";

    // Pre-populate the cache with [] to simulate the gcTime:0 race where the
    // eviction setTimeout hasn't fired yet when the component remounts.
    client.setQueryData(["runs.events", RUN_ID], []);

    // The network fetch is held pending so we can observe the component
    // while isFetching=true and stale [] is in cache.
    let resolveNetworkFetch!: (rows: PersistedRow[]) => void;
    eventsQueryFn.mockReturnValueOnce(
      new Promise<PersistedRow[]>((resolve) => {
        resolveNetworkFetch = resolve;
      }),
    );

    const { container } = render(
      <Wrapper client={client}>
        <RunEventStream runId={RUN_ID} />
      </Wrapper>,
    );

    // While the background refetch is in-flight the component must show the
    // loading state (not "no events yet"), because seeding from the stale []
    // cache at this point would permanently suppress the real events.
    await new Promise((r) => setTimeout(r, 30));
    expect(container.innerHTML).not.toContain("no events yet");

    // Resolve the pending fetch with real persisted events.
    resolveNetworkFetch([
      {
        id: 7,
        payload: { kind: "text", text: "real events after background fetch", iteration: 1 },
      },
    ]);

    // After the network response the real events must appear.
    await waitFor(
      () => {
        if (!container.innerHTML.includes("real events after background fetch")) {
          throw new Error(`Expected real events in DOM, got: ${container.innerHTML.slice(0, 400)}`);
        }
      },
      { timeout: 3000 },
    );
  });

  test("gcTime:0 — stale empty cache cleared on unmount; remount fetches fresh events", async () => {
    const client = makeClient();
    const RUN_ID = "run-stale-cache-regression";

    // ── First visit ── run just started, server had no events yet.
    eventsQueryFn.mockResolvedValueOnce([]);

    const { unmount, container } = render(
      <Wrapper client={client}>
        <RunEventStream runId={RUN_ID} />
      </Wrapper>,
    );

    // Wait for the initial (empty) seed to complete.
    await waitFor(
      () => {
        const html = container.innerHTML;
        // Loading spinner is gone, "no events yet" is shown.
        if (html.includes("loading run history")) {
          throw new Error("Still loading");
        }
      },
      { timeout: 3000 },
    );

    // Cache now holds [] for this runId.
    // biome-ignore lint/suspicious/noExplicitAny: test assertion on QueryClient internals
    expect(client.getQueryData(["runs.events", RUN_ID]) as any).toEqual([]);

    // ── Unmount (simulates navigating away) ──
    // With gcTime:0 the cache entry is scheduled for eviction via setTimeout(0).
    unmount();

    // Drain the microtask + macro-task queue so React-Query's gc timer fires.
    // gcTime:0 schedules setTimeout(gcFn, 0) — one event-loop tick is enough.
    await new Promise((r) => setTimeout(r, 10));

    // Verify the cache was cleared.
    // Pre-fix: the entry would still be [] (default gcTime keeps it 5 min).
    // Post-fix: the entry is gone so the next mount fetches fresh.
    expect(client.getQueryData(["runs.events", RUN_ID])).toBeUndefined();

    // ── Second visit ── run has now completed and DB has real events.
    eventsQueryFn.mockResolvedValueOnce([
      { id: 10, payload: { kind: "text", text: "agent completed the task", iteration: 1 } },
    ]);

    const { container: container2 } = render(
      <Wrapper client={client}>
        <RunEventStream runId={RUN_ID} />
      </Wrapper>,
    );

    // The fresh fetch should surface the real events.
    await waitFor(
      () => {
        const html = container2.innerHTML;
        if (!html.includes("agent completed the task")) {
          throw new Error(`Expected "agent completed the task" in DOM, got: ${html.slice(0, 500)}`);
        }
      },
      { timeout: 3000 },
    );
  });
});
