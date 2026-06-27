import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations } from "@factory/db";
import { dedupeKey, saveObservations } from "../src/watch/observation-store.ts";
import type { WorkRecord } from "../src/watch/sources/types.ts";
import { type RawObservation, synthesizeObservations } from "../src/watch/synthesize.ts";

function rec(id: string): WorkRecord {
  return {
    sourceId: "claude-code",
    sessionId: id,
    projectPath: "/home/x/dev/acme",
    gitBranch: "main",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    title: `built ${id}`,
    summary: "5 user / 9 assistant messages",
    signals: [],
  };
}

function fenced(observations: unknown): string {
  return `Here is what I found:\n\n\`\`\`json\n${JSON.stringify({ observations })}\n\`\`\`\n`;
}

describe("synthesizeObservations", () => {
  test("parses + validates a well-formed response", async () => {
    const invoke = async () =>
      fenced([
        {
          kind: "repeated-ritual",
          title: "Scaffolds CLIs by hand the same way",
          detail: "Three sessions ran the same plan→scaffold→implement steps.",
          evidence: [{ sourceId: "claude-code", sessionId: "s1" }],
          proposal: "adopt-as-task",
          targetProjectSlug: "clis",
        },
      ]);
    const obs = await synthesizeObservations([rec("s1")], [], { invoke });
    expect(obs).toHaveLength(1);
    const o = obs[0];
    if (!o) throw new Error("expected one observation");
    expect(o).toMatchObject({
      kind: "repeated-ritual",
      proposal: "adopt-as-task",
      targetProjectSlug: "clis",
    });
    expect(o.evidence).toEqual([{ sourceId: "claude-code", sessionId: "s1" }]);
  });

  test("drops items with an invalid kind/proposal or missing fields", async () => {
    const invoke = async () =>
      fenced([
        { kind: "nonsense", title: "x", detail: "y", proposal: "note-only", evidence: [] },
        { kind: "tooling-gap", title: "", detail: "y", proposal: "note-only", evidence: [] },
        { kind: "new-convention", title: "ok", detail: "d", proposal: "make-up", evidence: [] },
        { kind: "note-only-but-as-kind?", title: "x", detail: "y", proposal: "note-only" },
        {
          kind: "candidate-task",
          title: "Valid one",
          detail: "keeps",
          proposal: "note-only",
          evidence: [{ sourceId: "codex" }], // missing sessionId → evidence dropped
        },
      ]);
    const obs = await synthesizeObservations([rec("s1")], [], { invoke });
    expect(obs.map((o) => o.title)).toEqual(["Valid one"]);
    const first = obs[0];
    if (!first) throw new Error("expected one observation");
    expect(first.evidence).toEqual([]); // malformed evidence entry filtered out
    expect(first.targetProjectSlug).toBeNull();
  });

  test("throws on an unparseable response (null-parse-fail discipline)", async () => {
    const invoke = async () => "I couldn't find anything noteworthy.";
    await expect(synthesizeObservations([rec("s1")], [], { invoke })).rejects.toThrow();
  });

  test("short-circuits on empty input without invoking the model", async () => {
    let called = false;
    const invoke = async () => {
      called = true;
      return fenced([]);
    };
    expect(await synthesizeObservations([], [], { invoke })).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("saveObservations", () => {
  const obs = (title: string): RawObservation => ({
    kind: "repeated-ritual",
    title,
    detail: "d",
    evidence: [{ sourceId: "claude-code", sessionId: "s1" }],
    proposal: "note-only",
    targetProjectSlug: null,
  });

  test("dedupeKey is stable and normalizes the title", () => {
    expect(dedupeKey(obs("Builds   CLIs   By Hand"))).toBe(dedupeKey(obs("builds clis by hand")));
  });

  test("inserts once, skips a duplicate dedupe key", () => {
    const root = mkdtempSync(path.join(tmpdir(), "watch-obs-"));
    try {
      const dbPath = path.join(root, "data.db");
      runMigrations(dbPath);
      const db = createDb(dbPath);

      expect(saveObservations(db, [obs("Builds CLIs by hand")])).toEqual({
        inserted: 1,
        skipped: 0,
      });
      // Same normalized title → same dedupe key → skipped.
      expect(saveObservations(db, [obs("builds   clis   by hand")])).toEqual({
        inserted: 0,
        skipped: 1,
      });
      // A distinct observation inserts.
      expect(saveObservations(db, [obs("Different insight")])).toEqual({ inserted: 1, skipped: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
