import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { UpstreamChipView, type UpstreamStatus } from "../upstream-chip.tsx";

afterEach(() => {
  cleanup();
});

function status(over: Partial<UpstreamStatus>): UpstreamStatus {
  return {
    configured: true,
    branch: "main",
    remoteRef: "origin/main",
    ahead: 0,
    behind: 0,
    state: "up_to_date",
    ...over,
  };
}

const noop = () => undefined;

describe("UpstreamChipView", () => {
  test("up_to_date renders `in sync`, no push button", () => {
    const { container } = render(
      <UpstreamChipView upstream={status({})} dirty={false} onPush={noop} />,
    );
    expect(container.textContent).toContain("in sync");
    expect(container.getElementsByTagName("button")).toHaveLength(0);
  });

  test("ahead + clean shows a push button", () => {
    const { container } = render(
      <UpstreamChipView
        upstream={status({ state: "ahead", ahead: 3 })}
        dirty={false}
        onPush={noop}
      />,
    );
    expect(container.textContent).toContain("ahead 3");
    const buttons = container.getElementsByTagName("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("push");
  });

  test("ahead + dirty hides the push button and hints to commit", () => {
    const { container } = render(
      <UpstreamChipView
        upstream={status({ state: "ahead", ahead: 2 })}
        dirty={true}
        onPush={noop}
      />,
    );
    expect(container.getElementsByTagName("button")).toHaveLength(0);
    expect(container.textContent).toContain("commit to push");
  });

  test("behind shows read-only chip + manual hint, no push", () => {
    const { container } = render(
      <UpstreamChipView
        upstream={status({ state: "behind", behind: 4 })}
        dirty={false}
        onPush={noop}
      />,
    );
    expect(container.textContent).toContain("behind 4");
    expect(container.textContent).toContain("pull/resolve manually");
    expect(container.getElementsByTagName("button")).toHaveLength(0);
  });

  test("diverged shows counts + manual hint, no push", () => {
    const { container } = render(
      <UpstreamChipView
        upstream={status({ state: "diverged", ahead: 2, behind: 5 })}
        dirty={false}
        onPush={noop}
      />,
    );
    expect(container.textContent).toContain("↑2 ↓5");
    expect(container.textContent).toContain("pull/resolve manually");
    expect(container.getElementsByTagName("button")).toHaveLength(0);
  });

  test("no_remote shows `no remote` with no action or hint", () => {
    const { container } = render(
      <UpstreamChipView
        upstream={status({ configured: false, remoteRef: null, state: "no_remote" })}
        dirty={false}
        onPush={noop}
      />,
    );
    expect(container.textContent).toContain("no remote");
    expect(container.getElementsByTagName("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("pull/resolve manually");
  });

  test("clicking push invokes onPush", () => {
    let clicked = 0;
    const { container } = render(
      <UpstreamChipView
        upstream={status({ state: "ahead", ahead: 1 })}
        dirty={false}
        onPush={() => {
          clicked += 1;
        }}
      />,
    );
    fireEvent.click(container.getElementsByTagName("button")[0]!);
    expect(clicked).toBe(1);
  });

  test("pending disables the button; error surfaces the message", () => {
    const { container, rerender } = render(
      <UpstreamChipView
        upstream={status({ state: "ahead", ahead: 1 })}
        dirty={false}
        onPush={noop}
        pushing={true}
      />,
    );
    expect(container.getElementsByTagName("button")[0]?.disabled).toBe(true);
    expect(container.textContent).toContain("pushing…");

    rerender(
      <UpstreamChipView
        upstream={status({ state: "ahead", ahead: 1 })}
        dirty={false}
        onPush={noop}
        error="remote rejected the push (non-fast-forward)"
      />,
    );
    expect(container.textContent).toContain("remote rejected the push");
  });

  test("renders nothing when upstream is undefined", () => {
    const { container } = render(
      <UpstreamChipView upstream={undefined} dirty={false} onPush={noop} />,
    );
    expect(container.textContent).toBe("");
  });
});
