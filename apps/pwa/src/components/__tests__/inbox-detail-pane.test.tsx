import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DecisionRow } from "../decision-card.tsx";
import { InboxDetailPane } from "../inbox-detail-pane.tsx";

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

function renderPane(row: DecisionRow) {
  return render(
    <MemoryRouter>
      <InboxDetailPane
        item={{ kind: "decision", row, ideaText: null }}
        onDecisionAction={() => undefined}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("InboxDetailPane issue_intake", () => {
  test("renders the source issue as a link when the payload includes htmlUrl", () => {
    const { container } = renderPane(
      issueIntake({
        number: 43,
        title: "Linked issue",
        author: "octocat",
        htmlUrl: "https://github.com/rnwolfe/factory/issues/43",
      }),
    );

    const link = Array.from(container.getElementsByTagName("a")).find((a) =>
      a.textContent?.includes("#43 Linked issue"),
    );
    expect(link).not.toBeUndefined();
    expect(link?.getAttribute("href")).toBe("https://github.com/rnwolfe/factory/issues/43");
  });

  test("keeps the source issue as plain text when no URL is present", () => {
    const { container } = renderPane(
      issueIntake({ number: 42, title: "Legacy issue", author: "octocat" }),
    );

    expect(container.textContent).toContain("#42 Legacy issue");
    const issueLink = Array.from(container.getElementsByTagName("a")).find((a) =>
      a.textContent?.includes("#42 Legacy issue"),
    );
    expect(issueLink).toBeUndefined();
  });
});
