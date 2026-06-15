import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { SourceIssueLink, SourceLink, sourceIssueLabel } from "../source-link.tsx";

afterEach(() => {
  cleanup();
});

describe("SourceLink", () => {
  test("renders nothing when source data has no visible label", () => {
    const { container } = render(
      <SourceLink label="" href="https://github.com/rnwolfe/factory/issues/43" />,
    );

    expect(container.textContent).toBe("");
    expect(container.getElementsByTagName("a")).toHaveLength(0);
  });

  test("keeps a source as plain text when href is absent", () => {
    const { container } = render(<SourceLink label="#42 Legacy issue" />);

    expect(container.textContent).toBe("#42 Legacy issue");
    expect(container.getElementsByTagName("a")).toHaveLength(0);
  });

  test("renders a console-styled external link when label and href are present", () => {
    const { container } = render(
      <SourceLink label="#43 Linked issue" href=" https://github.com/rnwolfe/factory/issues/43 " />,
    );

    const link = container.getElementsByTagName("a").item(0);
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://github.com/rnwolfe/factory/issues/43");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.className).toContain("no-underline");
    expect(link?.className).toContain("border-b");
  });
});

describe("SourceIssueLink", () => {
  test("builds issue labels without placeholder issue numbers", () => {
    expect(sourceIssueLabel(43, "Linked issue")).toBe("#43 Linked issue");
    expect(sourceIssueLabel(null, "Title only")).toBe("Title only");
    expect(sourceIssueLabel(undefined, " ")).toBeNull();
  });

  test("uses a plain fallback label for incomplete issue payloads without a URL", () => {
    const { container } = render(
      <SourceIssueLink number={null} title="" href={null} fallbackLabel="GitHub issue" />,
    );

    expect(container.textContent).toBe("GitHub issue");
    expect(container.getElementsByTagName("a")).toHaveLength(0);
  });
});
