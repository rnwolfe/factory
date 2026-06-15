import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  type ProvenanceLink,
  ProvenanceLinks,
  SourceIssueLink,
  SourceLink,
  sourceIssueLabel,
  trustedGithubIssueHref,
  trustedSourceHref,
} from "../source-link.tsx";

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

  test("keeps unsafe source destinations as plain text", () => {
    for (const href of [
      "javascript:alert(1)",
      "//github.com/rnwolfe/factory/issues/43",
      "github.com/rnwolfe/factory/issues/43",
      "http://github.com/rnwolfe/factory/issues/43",
      "mailto:octocat@example.com",
    ]) {
      const { container, unmount } = render(<SourceLink label="unsafe source" href={href} />);

      expect(container.textContent).toBe("unsafe source");
      expect(container.getElementsByTagName("a")).toHaveLength(0);
      unmount();
    }
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

  test("links only to matching GitHub issue URLs", () => {
    expect(trustedGithubIssueHref("https://github.com/rnwolfe/factory/issues/43", 43)).toBe(
      "https://github.com/rnwolfe/factory/issues/43",
    );
    expect(trustedGithubIssueHref("http://github.com/rnwolfe/factory/issues/43", 43)).toBeNull();
    expect(trustedGithubIssueHref("https://github.com/rnwolfe/factory/pull/43", 43)).toBeNull();
    expect(trustedGithubIssueHref("https://github.com/rnwolfe/factory/issues/44", 43)).toBeNull();
  });
});

describe("ProvenanceLinks", () => {
  test("renders trusted internal and external links", () => {
    const links: ProvenanceLink[] = [
      { kind: "plan", label: "plan abc123", href: "/plans/abc123" },
      { kind: "issue", label: "issue #43", href: "https://github.com/rnwolfe/factory/issues/43" },
    ];
    const { container } = render(
      <MemoryRouter>
        <ProvenanceLinks links={links} />
      </MemoryRouter>,
    );

    const anchors = Array.from(container.getElementsByTagName("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "/plans/abc123",
      "https://github.com/rnwolfe/factory/issues/43",
    ]);
  });

  test("keeps untrusted provenance destinations as plain chips", () => {
    const links: ProvenanceLink[] = [
      { kind: "issue", label: "issue #43", href: "github.com/rnwolfe/factory/issues/43" },
    ];
    const { container } = render(<ProvenanceLinks links={links} />);

    expect(trustedSourceHref(links[0]?.href)).toBeNull();
    expect(container.textContent).toBe("issue #43");
    expect(container.getElementsByTagName("a")).toHaveLength(0);
  });
});
