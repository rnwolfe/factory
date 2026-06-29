import { useMemo } from "react";

/**
 * Soft cap on the source length we'll parse. A single agent text event can
 * be huge (the model dumps a 100KB+ reasoning block), and the inline
 * tokenizer is worst-case O(n²) on pathological inputs (long runs of
 * unmatched markers). Truncation here keeps any one event from freezing
 * the render thread; the full content is still in the raw xterm view.
 */
const SOURCE_CAP = 32_000;

// Hand-rolled markdown → React renderer covering the subset assistant text
// and operator/agent comments actually produce: paragraphs, headings, fenced
// code, inline code, bullet/ordered lists, task-list checkboxes, GFM tables,
// blockquotes, bold, italic, links.
// Treats unmatched inline markers as literal text — no dangerouslySetInnerHTML,
// no HTML pass-through. Bundle-weight-conscious: avoids pulling marked@13.
export function MarkdownBlock({ source }: { source: string }) {
  const { blocks, truncated } = useMemo(() => {
    if (source.length <= SOURCE_CAP) {
      return { blocks: parseBlocks(source), truncated: false };
    }
    return { blocks: parseBlocks(source.slice(0, SOURCE_CAP)), truncated: true };
  }, [source]);
  return (
    <div className="md-block">
      {blocks.map((block, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks are immutable per source
        <BlockNode key={idx} block={block} />
      ))}
      {truncated ? (
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">
          [truncated at {Math.round(SOURCE_CAP / 1000)}k chars — switch to [raw] view above for the
          full stream]
        </p>
      ) : null}
    </div>
  );
}

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "code"; lang: string | null; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; lines: string[] }
  | {
      kind: "table";
      headers: string[];
      align: ("left" | "right" | "center" | null)[];
      rows: string[][];
    }
  | { kind: "hr" };

type CellAlign = "left" | "right" | "center" | null;

/** Split a `| a | b |` table row into trimmed cells, dropping the leading/trailing pipes. */
function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** A GFM table separator row: `| --- | :--: | ---: |` — pipes + dashes, optional
 *  alignment colons. Requires a pipe so a bare `---` stays a horizontal rule. */
function isTableSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  const cells = splitTableRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Read alignment from a separator cell: leading colon → left, trailing → right,
 *  both → center, neither → default (null). */
function parseAlign(cell: string): CellAlign {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** True when `line` opens a GFM table (has a pipe and the next line is a separator). */
function startsTable(line: string, next: string): boolean {
  return line.includes("|") && isTableSeparator(next);
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      // skip closing fence (may be missing — be tolerant)
      if (i < lines.length) i++;
      out.push({ kind: "code", lang, lines: codeLines });
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ kind: "heading", level, text: heading[2] ?? "" });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // GFM table: header row + separator row, then body rows containing pipes
    if (startsTable(line, lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      const align = splitTableRow(lines[i + 1] ?? "").map(parseAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      out.push({ kind: "table", headers, align, rows });
      continue;
    }

    // Blockquote (consecutive `> ` lines)
    if (/^>\s?/.test(line)) {
      const qLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        qLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "blockquote", lines: qLines });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines
    const pLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") break;
      if (/^```/.test(l)) break;
      if (/^#{1,6}\s+/.test(l)) break;
      if (/^>\s?/.test(l)) break;
      if (/^\s*[-*]\s+/.test(l)) break;
      if (/^\s*\d+\.\s+/.test(l)) break;
      if (startsTable(l, lines[i + 1] ?? "")) break;
      pLines.push(l);
      i++;
    }
    if (pLines.length > 0) {
      out.push({ kind: "paragraph", lines: pLines });
    }
  }
  return out;
}

function BlockNode({ block }: { block: Block }) {
  if (block.kind === "paragraph") {
    return (
      <p className="md-p">
        <Inline text={block.lines.join(" ")} />
      </p>
    );
  }
  if (block.kind === "heading") {
    const Tag = `h${block.level}` as unknown as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return (
      <Tag className={`md-h md-h${block.level}`}>
        <Inline text={block.text} />
      </Tag>
    );
  }
  if (block.kind === "code") {
    return (
      <pre className="md-code" data-lang={block.lang ?? ""}>
        <code>{block.lines.join("\n")}</code>
      </pre>
    );
  }
  if (block.kind === "ul") {
    return (
      <ul className="md-ul">
        {block.items.map((item, i) => {
          // Task-list item: `[ ]`/`[x]`/`[X]` after the bullet marker → checkbox row.
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
          if (task) {
            const checked = task[1] !== " ";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable per source
              <li key={i} className="md-task-item flex items-baseline gap-2 list-none">
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  disabled
                  aria-checked={checked}
                  className="md-task-checkbox accent-[var(--color-accent)] translate-y-[1px]"
                />
                <span>
                  <Inline text={task[2] ?? ""} />
                </span>
              </li>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable per source
            <li key={i}>
              <Inline text={item} />
            </li>
          );
        })}
      </ul>
    );
  }
  if (block.kind === "ol") {
    return (
      <ol className="md-ol">
        {block.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable per source
          <li key={i}>
            <Inline text={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (block.kind === "blockquote") {
    return (
      <blockquote className="md-bq">
        <Inline text={block.lines.join(" ")} />
      </blockquote>
    );
  }
  if (block.kind === "table") {
    const alignOf = (col: number): "left" | "right" | "center" | undefined =>
      block.align[col] ?? undefined;
    return (
      // Horizontally scrollable so wide tables survive a 390px phone viewport.
      <div className="md-table-wrap overflow-x-auto">
        <table className="md-table w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {block.headers.map((cell, c) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells are immutable per source
                  key={c}
                  className="border border-[var(--color-line)] px-2 py-1 font-semibold text-[var(--color-fg)] whitespace-nowrap"
                  style={{ textAlign: alignOf(c) }}
                >
                  <Inline text={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: table rows are immutable per source
              <tr key={r}>
                {/* Iterate by header count so under/over-filled rows render gracefully. */}
                {block.headers.map((_, c) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are immutable per source
                    key={c}
                    className="border border-[var(--color-line)] px-2 py-1 align-top text-[var(--color-fg-1)]"
                    style={{ textAlign: alignOf(c) }}
                  >
                    <Inline text={row[c] ?? ""} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.kind === "hr") {
    return <hr className="md-hr" />;
  }
  return null;
}

interface InlineToken {
  kind: "text" | "code" | "bold" | "italic" | "link";
  content: string;
  /** url for links */
  href?: string;
}

/**
 * Tokenize one line of inline markdown. Order matters: code first (no inner
 * formatting), then links, then bold (** double), then italic (* or _ single).
 * Unmatched markers fall through as literal characters.
 */
function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  while (i < text.length) {
    // inline code `…`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        tokens.push({ kind: "code", content: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // link [text](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          const linkText = text.slice(i + 1, close);
          const href = text.slice(close + 2, urlEnd);
          tokens.push({ kind: "link", content: linkText, href });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // bold **…**
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        tokens.push({ kind: "bold", content: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // italic *…* or _…_
    if (text[i] === "*" || text[i] === "_") {
      const ch = text[i];
      const end = text.indexOf(ch ?? "*", i + 1);
      // make sure it's not adjacent (prevents matching ** as italic + extra *)
      if (end !== -1 && end !== i + 1) {
        tokens.push({ kind: "italic", content: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // plain text — consume until we hit a special char
    let j = i;
    while (
      j < text.length &&
      text[j] !== "`" &&
      text[j] !== "[" &&
      text[j] !== "*" &&
      text[j] !== "_"
    ) {
      j++;
    }
    if (j === i) {
      // hit a special char that didn't form a valid pair — emit as literal
      tokens.push({ kind: "text", content: text[i] ?? "" });
      i++;
    } else {
      tokens.push({ kind: "text", content: text.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

/** Render a single line of inline markdown (bold/italic/code/links). Exported for
 *  surfaces that lay out their own structure but still want inline formatting. */
export function Inline({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  return (
    <>
      {tokens.map((t, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: inline tokens are immutable per source
        if (t.kind === "text") return <span key={i}>{t.content}</span>;
        if (t.kind === "code") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: inline tokens are immutable per source
            <code key={i} className="md-inline-code">
              {t.content}
            </code>
          );
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: inline tokens are immutable per source
        if (t.kind === "bold") return <strong key={i}>{t.content}</strong>;
        // biome-ignore lint/suspicious/noArrayIndexKey: inline tokens are immutable per source
        if (t.kind === "italic") return <em key={i}>{t.content}</em>;
        if (t.kind === "link") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: inline tokens are immutable per source
            <a key={i} href={t.href} className="md-link" target="_blank" rel="noreferrer noopener">
              {t.content}
            </a>
          );
        }
        return null;
      })}
    </>
  );
}
