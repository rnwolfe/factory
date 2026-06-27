import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeCodeSource } from "../src/watch/sources/claude-code.ts";
import { createCodexSource } from "../src/watch/sources/codex.ts";
import {
  getHarnessSource,
  HARNESS_SOURCE_REGISTRY,
  listHarnessSources,
} from "../src/watch/sources/registry.ts";

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function jsonl(lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

describe("claudeCodeSource", () => {
  function seed(): { root: string; cleanup: () => void } {
    const root = tmp("watch-claude-");
    const projDir = path.join(root, "projects", "-home-rnwolfe-dev-acme");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      path.join(projDir, "sess-1.jsonl"),
      jsonl([
        {
          type: "user",
          timestamp: "2026-06-20T10:00:00.000Z",
          cwd: "/home/rnwolfe/dev/acme",
          gitBranch: "main",
          sessionId: "sess-1",
          message: { role: "user", content: "build a CLI for acme" },
        },
        {
          type: "assistant",
          timestamp: "2026-06-20T10:01:00.000Z",
          sessionId: "sess-1",
          message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
        },
        {
          type: "user",
          timestamp: "2026-06-20T10:02:00.000Z",
          sessionId: "sess-1",
          message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" },
        },
      ]),
    );
    const memDir = path.join(projDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(path.join(memDir, "MEMORY.md"), "- [a fact](a.md)\n");
    writeFileSync(path.join(memDir, ".env"), "SECRET=nope\n"); // must be skipped
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("isAvailable reflects the projects dir", async () => {
    const { root, cleanup } = seed();
    try {
      expect(await createClaudeCodeSource({ root }).isAvailable()).toBe(true);
      expect(await createClaudeCodeSource({ root: path.join(root, "nope") }).isAvailable()).toBe(
        false,
      );
    } finally {
      cleanup();
    }
  });

  test("scan normalizes a session and advances the cursor", async () => {
    const { root, cleanup } = seed();
    try {
      const src = createClaudeCodeSource({ root });
      const { records, next } = await src.scan(null);
      expect(records).toHaveLength(1);
      const r = records[0];
      if (!r) throw new Error("expected one record");
      expect(r.sourceId).toBe("claude-code");
      expect(r.sessionId).toBe("sess-1");
      expect(r.projectPath).toBe("/home/rnwolfe/dev/acme");
      expect(r.gitBranch).toBe("main");
      expect(r.title).toBe("build a CLI for acme"); // first real prompt, not the reminder
      expect(r.summary).toContain("2 user / 1 assistant");
      expect(r.startedAt).toBe(Date.parse("2026-06-20T10:00:00.000Z"));
      expect(r.endedAt).toBe(Date.parse("2026-06-20T10:02:00.000Z"));

      // A second scan from the advanced cursor sees nothing new.
      const again = await src.scan(next);
      expect(again.records).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("readMemories returns markdown docs and skips secret files", async () => {
    const { root, cleanup } = seed();
    try {
      const docs = await createClaudeCodeSource({ root }).readMemories();
      expect(docs).toHaveLength(1);
      const doc = docs[0];
      if (!doc) throw new Error("expected one memory doc");
      expect(doc.title).toContain("MEMORY.md");
      expect(doc.body).toContain("a fact");
      expect(docs.some((d) => d.path.endsWith(".env"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("codexSource", () => {
  function seed(): { root: string; cleanup: () => void } {
    const root = tmp("watch-codex-");
    // ts in epoch SECONDS (Codex history) — source must normalize to ms.
    writeFileSync(
      path.join(root, "history.jsonl"),
      jsonl([
        { session_id: "c1", text: "list reservations", ts: 1_700_000_000 },
        { session_id: "c1", text: "cancel one", ts: 1_700_000_060 },
        { session_id: "c2", text: "scaffold cli", ts: 1_700_000_500 },
      ]),
    );
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("scan groups history by session", async () => {
    const { root, cleanup } = seed();
    try {
      const { records } = await createCodexSource({ root }).scan(null);
      expect(records).toHaveLength(2);
      const c1 = records.find((r) => r.sessionId === "c1");
      expect(c1?.title).toBe("list reservations");
      expect(c1?.summary).toBe("2 prompts");
      expect(c1?.startedAt).toBe(1_700_000_000 * 1000); // seconds → ms
      expect(c1?.endedAt).toBe(1_700_000_060 * 1000);
    } finally {
      cleanup();
    }
  });

  test("isAvailable requires history.jsonl", async () => {
    const { root, cleanup } = seed();
    try {
      expect(await createCodexSource({ root }).isAvailable()).toBe(true);
      expect(await createCodexSource({ root: path.join(root, "nope") }).isAvailable()).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("registry", () => {
  test("registers both built-in sources, keyed by id", () => {
    expect(
      listHarnessSources()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["claude-code", "codex"]);
    expect(getHarnessSource("claude-code")?.label).toBe("Claude Code");
    expect(getHarnessSource("codex")?.label).toBe("Codex");
    expect(getHarnessSource("nope")).toBeUndefined();
    // keyed by the source's own id (no drift between key and id)
    for (const [key, src] of Object.entries(HARNESS_SOURCE_REGISTRY)) expect(key).toBe(src.id);
  });
});
