import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { WatchPanelView, type WatchStatus } from "../watch-panel.tsx";

afterEach(() => {
  cleanup();
});

const EMPTY: WatchStatus = {
  cadence: "daily",
  lastScanAt: null,
  sources: [],
  observations: {
    total: 0,
    pending: 0,
    surfaced: 0,
    adopted: 0,
    dismissed: 0,
    superseded: 0,
  },
  recent: [],
};

const POPULATED: WatchStatus = {
  cadence: "hourly",
  lastScanAt: Date.now() - 90_000,
  sources: [
    {
      id: "claude-code",
      label: "Claude Code sessions",
      available: true,
      position: "2026-06-28T00:00:00Z",
      lastScanAt: Date.now() - 90_000,
    },
    {
      id: "codex",
      label: "Codex sessions",
      available: false,
      position: null,
      lastScanAt: null,
    },
  ],
  observations: {
    total: 3,
    pending: 1,
    surfaced: 1,
    adopted: 0,
    dismissed: 0,
    superseded: 1,
  },
  recent: [
    {
      id: "obs-1",
      kind: "correction-pattern",
      title: "Keeps re-running the same failing test",
      detail: "...",
      proposal: "note-only",
      status: "pending",
      targetProjectSlug: "factory",
      createdAt: Date.now() - 90_000,
    },
    {
      id: "obs-2",
      kind: "candidate-task",
      title: "Extract a shared relative-time helper",
      detail: "...",
      proposal: "adopt-as-task",
      status: "surfaced",
      targetProjectSlug: null,
      createdAt: Date.now() - 180_000,
    },
  ],
};

describe("WatchPanelView", () => {
  test("shows the quiet placeholder when nothing has synthesized yet", () => {
    const { container } = render(<WatchPanelView data={EMPTY} />);
    expect(container.textContent).toContain("The Watch hasn't synthesized anything yet");
    // header line still renders the cadence
    expect(container.textContent).toContain("daily");
  });

  test("renders cadence, funnel, sources, and recent observations when populated", () => {
    const { container } = render(<WatchPanelView data={POPULATED} />);
    const text = container.textContent ?? "";
    // header / cadence
    expect(text).toContain("hourly");
    // funnel counts present (total + statuses)
    expect(text).toContain("total");
    expect(text).toContain("superseded");
    // source rows
    expect(text).toContain("Claude Code sessions");
    expect(text).toContain("available");
    expect(text).toContain("unavailable");
    // recent observation incl. a note-only one that never hit the inbox
    expect(text).toContain("Keeps re-running the same failing test");
    expect(text).toContain("note-only");
    expect(text).toContain("factory");
    // not the empty placeholder
    expect(text).not.toContain("hasn't synthesized anything yet");
  });

  test("renders an error fallback when data is absent and not loading", () => {
    const { container } = render(<WatchPanelView data={undefined} />);
    expect(container.textContent).toContain("couldn't load The Watch status");
  });
});
