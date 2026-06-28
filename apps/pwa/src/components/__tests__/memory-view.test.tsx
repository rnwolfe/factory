import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { type MemoryData, MemoryView } from "../../routes/memory.tsx";

afterEach(() => {
  cleanup();
});

const EMPTY: MemoryData = {
  repoPath: "/home/op/.factory/operator-memory",
  facts: [],
};

const POPULATED: MemoryData = {
  repoPath: "/home/op/.factory/operator-memory",
  facts: [
    {
      file: "binds-dev-servers-to-0-0-0-0.md",
      name: "binds-dev-servers-to-0-0-0-0",
      description: "Always bind dev servers to 0.0.0.0, never localhost.",
      type: "user",
      body: "# Bind to 0.0.0.0\n\nReachable from the LAN.",
      provenance: ["watch:obs-42", "claude-code/abc1234"],
    },
    {
      file: "prefers-preformatted-bodies.md",
      name: "prefers-preformatted-bodies",
      description: "Render fact bodies as preformatted text.",
      type: "reference",
      body: "Use <pre> for memory bodies.",
    },
  ],
};

describe("MemoryView", () => {
  test("shows the quiet empty-state explainer when there are no facts", () => {
    const { container } = render(<MemoryView data={EMPTY} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Operator memory is empty.");
    expect(text).toContain("record-as-convention");
    // repoPath still shown
    expect(text).toContain("/home/op/.factory/operator-memory");
  });

  test("groups facts by type and reveals body + provenance on expand", () => {
    const { container } = render(<MemoryView data={POPULATED} />);
    const text = container.textContent ?? "";
    // section labels + fact names render
    expect(text).toContain("user");
    expect(text).toContain("reference");
    expect(text).toContain("binds-dev-servers-to-0-0-0-0");
    expect(text).toContain("Always bind dev servers to 0.0.0.0");
    // collapsed by default: body + provenance hidden
    expect(text).not.toContain("Reachable from the LAN");
    expect(text).not.toContain("watch:obs-42");

    // expand the first fact (the "user"-type fact renders first)
    const firstFactButton = container.getElementsByTagName("button")[0];
    expect(firstFactButton).toBeDefined();
    fireEvent.click(firstFactButton);
    const expanded = container.textContent ?? "";
    expect(expanded).toContain("Reachable from the LAN");
    expect(expanded).toContain("watch:obs-42");
    expect(expanded).toContain("claude-code/abc1234");
  });

  test("renders an error fallback when data is absent", () => {
    const { container } = render(<MemoryView data={undefined} />);
    expect(container.textContent).toContain("couldn't load operator memory");
  });
});
