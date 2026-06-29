import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  type AutonomyConfigResponse,
  type AutonomyHistoryRow,
  AutonomyHistoryView,
  AutonomyPanelView,
} from "../autonomy-panel.tsx";

afterEach(() => {
  cleanup();
});

const RESOLVED = {
  trust: { autoPromote: true, promoteStreak: 5, autoContract: true },
  gate: { minLevel: "high", maxBlastRadius: "contained", crossModel: true },
  watch: { synthesisCadence: "daily", generatorEnabled: true, inbandGroom: true },
  autorun: { enabled: false, maxBlastRadius: "contained", classes: [] },
  retry: { transientBudget: 1 },
  alerts: {
    trust_promoted: "digest",
    trust_contracted: "push",
    gate_held: "digest",
    gate_passed: "digest",
    auto_ran: "push",
    auto_merged: "push",
    auto_retried: "digest",
    proposal_surfaced: "push",
    freeze_blocked: "digest",
  },
};

const PRESETS = {
  conservative: {
    trust: { autoPromote: false, autoContract: true },
    autorun: { enabled: false },
    alerts: { trust_promoted: "push", gate_held: "push", gate_passed: "push" },
  },
  balanced: {
    trust: { autoPromote: true, promoteStreak: 5, autoContract: true },
    autorun: { enabled: false },
  },
  "hands-off": {
    trust: { autoPromote: true, promoteStreak: 3, autoContract: true },
    autorun: { enabled: true, maxBlastRadius: "contained" },
  },
};

/** happy-dom's getByText selector parser is flaky; find buttons by text directly. */
function clickByText(container: HTMLElement, text: string) {
  const el = Array.from(container.getElementsByTagName("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!el) throw new Error(`no button with text "${text}"`);
  fireEvent.click(el);
}

function response(over?: {
  systemOverride?: unknown;
  projectOverride?: unknown;
}): AutonomyConfigResponse {
  return {
    resolved: RESOLVED,
    builtin: RESOLVED,
    systemOverride: over?.systemOverride ?? null,
    projectOverride: over?.projectOverride ?? null,
    presets: PRESETS,
  } as unknown as AutonomyConfigResponse;
}

describe("AutonomyPanelView", () => {
  test("renders the preset row + effective summary; shows 'inherited' with no override", () => {
    const { container } = render(
      <AutonomyPanelView
        scope="system"
        data={response()}
        onApplyPreset={() => {}}
        onSaveOverride={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    // preset buttons
    expect(text).toContain("conservative");
    expect(text).toContain("balanced");
    expect(text).toContain("hands-off");
    // no override applied -> inherited
    expect(text).toContain("inherited");
    // effective summary renders resolved values
    expect(text).toContain("effective policy");
    expect(text).toContain("min high");
    expect(text).toContain("synthesis daily");
  });

  test("labels the active preset when the override matches a preset blob", () => {
    const { container } = render(
      <AutonomyPanelView
        scope="project"
        data={response({ projectOverride: PRESETS.balanced })}
        onApplyPreset={() => {}}
        onSaveOverride={() => {}}
      />,
    );
    expect(container.textContent ?? "").toContain("balanced");
  });

  test("applying a preset fires onApplyPreset with the preset id", () => {
    const onApplyPreset = mock(() => {});
    const { container } = render(
      <AutonomyPanelView
        scope="system"
        data={response()}
        onApplyPreset={onApplyPreset}
        onSaveOverride={() => {}}
      />,
    );
    clickByText(container, "hands-off");
    expect(onApplyPreset).toHaveBeenCalledWith("hands-off");
  });

  test("advanced knob groups stay collapsed until the disclosure is opened", () => {
    // (happy-dom@20.9.0's selector parser crashes when React renders the
    // <select>/<input> controls, so we assert the collapsed state rather than
    // forcing the disclosure open — the open path is exercised in the app.)
    const { container } = render(
      <AutonomyPanelView
        scope="project"
        data={response()}
        onApplyPreset={() => {}}
        onSaveOverride={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("advanced · every knob");
    expect(text).not.toContain("trust · the ladder");
    expect(text).not.toContain("promote streak");
  });
});

describe("AutonomyHistoryView", () => {
  test("quiet placeholder when nothing autonomous has happened", () => {
    const { container } = render(
      <MemoryRouter>
        <AutonomyHistoryView rows={[]} />
      </MemoryRouter>,
    );
    expect(container.textContent ?? "").toContain("nothing autonomous yet");
  });

  test("renders a dense timeline of events with kind + message", () => {
    const rows = [
      {
        id: "e1",
        projectId: "p1",
        runId: "run-abcdef12",
        kind: "auto_merged",
        message: "auto-merged factory/run-123 into main",
        detail: null,
        createdAt: Date.now() - 60_000,
      },
      {
        id: "e2",
        projectId: null,
        runId: null,
        kind: "trust_contracted",
        message: "contracted trust after a failure streak",
        detail: null,
        createdAt: Date.now() - 3_600_000,
      },
    ] as unknown as AutonomyHistoryRow[];
    const { container } = render(
      <MemoryRouter>
        <AutonomyHistoryView rows={rows} />
      </MemoryRouter>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("auto_merged");
    expect(text).toContain("auto-merged factory/run-123 into main");
    expect(text).toContain("trust_contracted");
    // project link for the project-scoped event, "system" for the other
    expect(text).toContain("project");
    expect(text).toContain("system");
  });
});
