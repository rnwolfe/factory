import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MarkdownBlock } from "../markdown-block.tsx";

afterEach(() => {
  cleanup();
});

// happy-dom's querySelector parser is broken in this harness (it dereferences an
// undefined SyntaxError), and getElementsByClassName routes through it — so these
// tests query via getElementsByTagName + classList.contains only.
const tags = (el: Element | Document, name: string) =>
  Array.from(el.getElementsByTagName(name)) as HTMLElement[];
const classed = (el: Element | Document, tag: string, cls: string) =>
  tags(el, tag).filter((e) => e.classList.contains(cls));

describe("MarkdownBlock — GFM tables", () => {
  test("renders a real table with header/body and per-column alignment", () => {
    const src = [
      "| Name | Score | Notes |",
      "| :--- | ----: | :---: |",
      "| **a** | 1 | `x` |",
      "| b | 22 | y |",
    ].join("\n");
    const { container } = render(<MarkdownBlock source={src} />);

    expect(tags(container, "table")).toHaveLength(1);

    const thead = tags(container, "thead")[0] as HTMLElement;
    const headers = tags(thead, "th");
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Score", "Notes"]);
    // Alignment from the separator row: left / right / center.
    expect(headers[0]?.style.textAlign).toBe("left");
    expect(headers[1]?.style.textAlign).toBe("right");
    expect(headers[2]?.style.textAlign).toBe("center");

    const tbody = tags(container, "tbody")[0] as HTMLElement;
    const bodyRows = tags(tbody, "tr");
    expect(bodyRows).toHaveLength(2);

    // Inline formatting renders inside cells.
    expect(tags(tbody, "strong")[0]?.textContent).toBe("a");
    expect(tags(tbody, "code")[0]?.textContent).toBe("x");

    // Body cells inherit the column alignment.
    const firstRowCells = tags(bodyRows[0] as HTMLElement, "td");
    expect(firstRowCells[1]?.style.textAlign).toBe("right");

    // Horizontally scrollable wrapper for narrow viewports.
    expect(classed(container, "div", "md-table-wrap")[0]?.className).toContain("overflow-x-auto");
  });

  test("handles rows with fewer/more cells than headers gracefully", () => {
    const src = ["| A | B |", "| --- | --- |", "| only-one |", "| x | y | z |"].join("\n");
    const { container } = render(<MarkdownBlock source={src} />);

    const tbody = tags(container, "tbody")[0] as HTMLElement;
    const rows = tags(tbody, "tr");
    // Every row renders exactly headers.length cells.
    for (const row of rows) {
      expect(tags(row, "td")).toHaveLength(2);
    }
    // Missing cell is empty; extra cell is dropped.
    const row0 = tags(rows[0] as HTMLElement, "td");
    expect(row0[0]?.textContent).toBe("only-one");
    expect(row0[1]?.textContent).toBe("");
    const row1 = tags(rows[1] as HTMLElement, "td");
    expect(row1[1]?.textContent).toBe("y");
  });

  test("a bare --- line stays a horizontal rule, not a table", () => {
    const { container } = render(<MarkdownBlock source={"above\n\n---\n\nbelow"} />);
    expect(tags(container, "table")).toHaveLength(0);
    expect(tags(container, "hr")).toHaveLength(1);
  });
});

describe("MarkdownBlock — task-list checkboxes", () => {
  test("renders checkboxes for [ ]/[x] items and plain bullets otherwise", () => {
    const src = ["- [ ] todo item", "- [x] done item", "- [X] also done", "- regular bullet"].join(
      "\n",
    );
    const { container } = render(<MarkdownBlock source={src} />);

    const checkboxes = tags(container, "input") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[1]?.checked).toBe(true);
    expect(checkboxes[2]?.checked).toBe(true);

    // Display-only: disabled so they're not interactive.
    for (const box of checkboxes) {
      expect(box.disabled).toBe(true);
    }

    // Checkbox items drop the bullet; the literal "[ ]" text is gone.
    const taskItems = classed(container, "li", "md-task-item");
    expect(taskItems).toHaveLength(3);
    expect(taskItems[0]?.textContent).toBe("todo item");
    expect(container.textContent).not.toContain("[ ]");
    expect(container.textContent).not.toContain("[x]");

    // A <ul> mixes checkbox and normal items: 4 items, last one plain.
    const items = tags(container, "li");
    expect(items).toHaveLength(4);
    expect(items[3]?.className).not.toContain("md-task-item");
    expect(items[3]?.textContent).toBe("regular bullet");
  });

  test("renders inline formatting inside a task item", () => {
    const { container } = render(<MarkdownBlock source={"- [x] ship **it** now"} />);
    const item = classed(container, "li", "md-task-item")[0] as HTMLElement;
    expect(tags(item, "strong")[0]?.textContent).toBe("it");
  });
});
