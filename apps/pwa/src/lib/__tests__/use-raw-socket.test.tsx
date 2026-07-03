/**
 * Reconnect-discipline tests for `useRawSocket`.
 *
 * The inline `/ws/inbox` sockets used to have no `onclose` handler at all: a
 * single dropped connection (wifi blip, daemon restart, phone sleep) silently
 * killed live push until a full remount. `useRawSocket` centralizes the same
 * backoff/teardown discipline the scoped `/ws/events` hook already had, so we
 * pin the three behaviors that matter:
 *   1. a dropped socket reconnects (a new WebSocket is constructed),
 *   2. messages reach the consumer's handler,
 *   3. an unmount is an intentional close — no reconnect storm afterward.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";

// getToken is read inside the hook's effect — stub it so a socket is opened.
mock.module("../auth.ts", () => ({ getToken: () => "test-token" }));

const { useRawSocket } = await import("../use-channel.ts");

// --------------------------------------------------------------------------
// A minimal WebSocket stub that records every instance and lets the test
// drive the `onopen` / `onmessage` / `onclose` lifecycle by hand.
// --------------------------------------------------------------------------
class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  // biome-ignore lint/suspicious/noExplicitAny: swapping in a test double for the global
  globalThis.WebSocket = FakeSocket as any;
});

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
});

describe("useRawSocket", () => {
  test("opens a socket to the given path with the token appended", () => {
    renderHook(() => useRawSocket("/ws/inbox", () => {}));
    expect(FakeSocket.instances.length).toBe(1);
    expect(FakeSocket.instances[0]?.url).toContain("/ws/inbox");
    expect(FakeSocket.instances[0]?.url).toContain("token=test-token");
  });

  test("delivers message frames to the consumer handler", () => {
    let received: string | null = null;
    renderHook(() =>
      useRawSocket("/ws/inbox", (e) => {
        received = e.data as string;
      }),
    );
    FakeSocket.instances[0]?.onmessage?.({ data: "hello" });
    expect(received).toBe("hello");
  });

  test("reconnects after the socket drops (backoff)", async () => {
    renderHook(() => useRawSocket("/ws/inbox", () => {}));
    expect(FakeSocket.instances.length).toBe(1);

    // Simulate an unexpected drop — the daemon restarting, wifi blipping, etc.
    FakeSocket.instances[0]?.onopen?.(); // reset attempt so backoff is the 1s base
    FakeSocket.instances[0]?.onclose?.();

    // A new socket should be constructed within the first backoff window (~1s).
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
    expect(FakeSocket.instances[1]?.url).toContain("/ws/inbox");
  });

  test("does not reconnect after an intentional unmount", async () => {
    const { unmount } = renderHook(() => useRawSocket("/ws/inbox", () => {}));
    expect(FakeSocket.instances.length).toBe(1);
    const sock = FakeSocket.instances[0];

    unmount();
    expect(sock?.closed).toBe(true);

    // Even if the browser fires `onclose` after our `.close()`, the effect's
    // cancellation flag must suppress any reconnect.
    sock?.onclose?.();
    await new Promise((r) => setTimeout(r, 1200));
    expect(FakeSocket.instances.length).toBe(1);
  });

  test("holds the socket closed when path is null", () => {
    renderHook(() => useRawSocket(null, () => {}));
    expect(FakeSocket.instances.length).toBe(0);
  });
});
