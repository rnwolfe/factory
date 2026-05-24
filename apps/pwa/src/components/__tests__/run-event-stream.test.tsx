/**
 * Regression test for the "empty events on run page revisit" bug.
 *
 * Root cause: `staleTime: Infinity` on the `runs.events` query meant that an
 * empty response cached during a first visit (e.g., when the run had just
 * started and the events table was empty) persisted for the default 5-minute
 * gcTime window. On the next navigation to the same run page the component
 * received [] from cache, seeded with nothing, set seeded=true, and disabled
 * the query — so the real persisted events were never fetched.
 *
 * Fix: `gcTime: 0` on the query evicts the cache entry the instant the last
 * observer (the component) unmounts. Every page navigation therefore starts
 * with a cold cache and gets the current server state.
 *
 * The gcTime test fails against the pre-fix code (no gcTime:0) and passes
 * after the fix.
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
