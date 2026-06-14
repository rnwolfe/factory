import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { DecisionCard, type DecisionRow } from "../decision-card.tsx";

function issueIntake(payload: DecisionRow["payload"]): DecisionRow {
  return {
    id: "dec-issue",
    kind: "issue_intake",
    outcome: "intake",
    weightedScore: null,
    uncertainty: null,
    createdAt: Date.now(),
    payload,
    projectId: "project-1",
    projectName: "Factory",
  };
}

afterEach(() => {
  cleanup();
});

describe("DecisionCard issue_intake", () => {
  test("renders existing payloads without a source URL", () => {
    const { container } = render(
      <DecisionCard
        decision={issueIntake({ number: 42, title: "Legacy issue", author: "octocat" })}
        onAction={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(container.textContent).toContain("#42 Legacy issue");
    expect(container.textContent).toContain("filed by @octocat on GitHub");
    expect(container.getElementsByTagName("a")).toHaveLength(0);
  });

  test("renders a source link when the payload includes htmlUrl", () => {
    const { container } = render(
      <DecisionCard
        decision={issueIntake({
          number: 43,
          title: "Linked issue",
          author: "octocat",
          htmlUrl: "https://github.com/rnwolfe/factory/issues/43",
        })}
        onAction={() => undefined}
        onOpen={() => undefined}
      />,
    );

    const link = container.getElementsByTagName("a").item(0);
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://github.com/rnwolfe/factory/issues/43");
    expect(link.textContent).toContain("#43 Linked issue");
  });
});
