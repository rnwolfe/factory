import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  parseVerifierReport,
  VerifierReport,
  type VerifierReportView,
} from "../verifier-report.tsx";

afterEach(() => {
  cleanup();
});

describe("parseVerifierReport", () => {
  test("returns null for null/empty/unparseable input", () => {
    expect(parseVerifierReport(null)).toBeNull();
    expect(parseVerifierReport(undefined)).toBeNull();
    expect(parseVerifierReport("")).toBeNull();
    expect(parseVerifierReport("{not json")).toBeNull();
    // shape guard — missing score / signals
    expect(parseVerifierReport(JSON.stringify({ level: "high" }))).toBeNull();
  });

  test("parses a well-formed report", () => {
    const raw = JSON.stringify({
      score: 1,
      level: "high",
      signals: [{ key: "acceptance", label: "Acceptance criteria", state: "pass", detail: "ok" }],
    });
    const parsed = parseVerifierReport(raw);
    expect(parsed?.level).toBe("high");
    expect(parsed?.signals).toHaveLength(1);
  });
});

describe("VerifierReport", () => {
  test("renders a muted note when report is null", () => {
    const { container } = render(<VerifierReport report={null} />);
    expect(container.textContent).toContain("no verification coverage recorded");
  });

  test("renders the level chip with score percent", () => {
    const report: VerifierReportView = {
      score: 1,
      level: "high",
      signals: [
        { key: "acceptance", label: "Acceptance criteria", state: "pass", detail: "all met" },
      ],
    };
    const { container } = render(<VerifierReport report={report} />);
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("100%");
    expect(container.innerHTML).toContain("chip-greenlit");
  });

  test("renders an absent signal as 'not covered', not a pass", () => {
    const report: VerifierReportView = {
      score: 0,
      level: "none",
      signals: [
        {
          key: "cross-model",
          label: "Cross-model check",
          state: "absent",
          detail: "no second model reviewed this run",
        },
      ],
    };
    const { container } = render(<VerifierReport report={report} />);
    expect(container.textContent).toContain("Cross-model check");
    expect(container.textContent).toContain("not covered");
    // absent must not render a check glyph
    expect(container.textContent).not.toContain("✓");
    expect(container.innerHTML).toContain("chip-trashed");
  });
});
