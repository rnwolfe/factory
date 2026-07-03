import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { followFileBytes, followFileLines } from "../src/tail.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tail-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await Bun.sleep(10);
  }
  return false;
}

describe("followFileLines", () => {
  test("emits complete lines and buffers a partial line until it completes", async () => {
    const file = path.join(dir, "lines.log");
    writeFileSync(file, "line1\npart");
    const ac = new AbortController();
    const lines: string[] = [];
    const h = followFileLines(file, (l) => lines.push(l), ac.signal, { pollMs: 10 });

    // "line1" is complete; "part" has no newline yet, so it stays buffered.
    expect(await waitFor(() => lines.length === 1)).toBe(true);
    expect(lines).toEqual(["line1"]);

    // Completing the partial line and adding another emits both.
    appendFileSync(file, "ial\nline3\n");
    expect(await waitFor(() => lines.length === 3)).toBe(true);
    expect(lines).toEqual(["line1", "partial", "line3"]);

    await h.stop();
  });

  test("only new bytes past the offset are read on each poll (paging)", async () => {
    const file = path.join(dir, "paging.log");
    writeFileSync(file, "a\n");
    const ac = new AbortController();
    const lines: string[] = [];
    const h = followFileLines(file, (l) => lines.push(l), ac.signal, { pollMs: 10 });

    expect(await waitFor(() => lines.length === 1)).toBe(true);
    appendFileSync(file, "b\n");
    expect(await waitFor(() => lines.length === 2)).toBe(true);
    // No duplication of the already-consumed "a".
    expect(lines).toEqual(["a", "b"]);

    await h.stop();
  });

  test("flushes a trailing partial line (no newline) when stopped", async () => {
    const file = path.join(dir, "tail.log");
    writeFileSync(file, "done\nremainder");
    const ac = new AbortController();
    const lines: string[] = [];
    const h = followFileLines(file, (l) => lines.push(l), ac.signal, { pollMs: 10 });

    expect(await waitFor(() => lines.length === 1)).toBe(true);
    expect(lines).toEqual(["done"]);

    // stop() runs a final flush that emits the buffered partial line.
    await h.stop();
    expect(lines).toEqual(["done", "remainder"]);
  });

  test("resets and re-reads from the start when the file is truncated", async () => {
    const file = path.join(dir, "trunc.log");
    writeFileSync(file, "aaaa\nbbbb\n");
    const ac = new AbortController();
    const lines: string[] = [];
    const h = followFileLines(file, (l) => lines.push(l), ac.signal, { pollMs: 10 });

    expect(await waitFor(() => lines.length === 2)).toBe(true);
    expect(lines).toEqual(["aaaa", "bbbb"]);

    // Shrink the file: size < offset triggers a reset, then the smaller
    // content is read afresh.
    writeFileSync(file, "x\n");
    expect(await waitFor(() => lines.includes("x"))).toBe(true);
    expect(lines).toEqual(["aaaa", "bbbb", "x"]);

    await h.stop();
  });
});

describe("followFileBytes", () => {
  test("emits raw byte chunks incrementally without waiting for newlines", async () => {
    const file = path.join(dir, "bytes.log");
    writeFileSync(file, "abc");
    const ac = new AbortController();
    const chunks: Uint8Array[] = [];
    const h = followFileBytes(file, (c) => chunks.push(c), ac.signal, { pollMs: 10 });

    // No newline, but the bytes still surface.
    expect(await waitFor(() => joined(chunks) === "abc")).toBe(true);

    appendFileSync(file, "def");
    expect(await waitFor(() => joined(chunks) === "abcdef")).toBe(true);

    await h.stop();
  });

  test("resets the offset when the file is truncated", async () => {
    const file = path.join(dir, "bytes-trunc.log");
    writeFileSync(file, "hello");
    const ac = new AbortController();
    const chunks: Uint8Array[] = [];
    const h = followFileBytes(file, (c) => chunks.push(c), ac.signal, { pollMs: 10 });

    expect(await waitFor(() => joined(chunks) === "hello")).toBe(true);

    // Truncate to shorter content; offset resets and the new bytes are read.
    writeFileSync(file, "hi");
    expect(await waitFor(() => joined(chunks) === "hellohi")).toBe(true);

    await h.stop();
  });

  test("stops reading after abort", async () => {
    const file = path.join(dir, "bytes-abort.log");
    writeFileSync(file, "one");
    const ac = new AbortController();
    const chunks: Uint8Array[] = [];
    const h = followFileBytes(file, (c) => chunks.push(c), ac.signal, { pollMs: 10 });

    expect(await waitFor(() => joined(chunks) === "one")).toBe(true);
    ac.abort();
    await h.stop();

    const settled = joined(chunks);
    // Anything written after abort + stop must not be picked up.
    appendFileSync(file, "two");
    await Bun.sleep(50);
    expect(joined(chunks)).toBe(settled);
  });
});

function joined(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join("");
}
