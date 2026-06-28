import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMemoryFacts } from "../src/memory/operator-memory.ts";
import { buildSeedPrompt, seedOperatorMemory } from "../src/memory/seed.ts";
import type { MemoryDoc } from "../src/watch/sources/types.ts";

function tmpRepo(): { repo: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "memory-seed-"));
  return {
    repo: path.join(root, "operator-memory"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const DOCS: MemoryDoc[] = [
  {
    sourceId: "claude-code",
    path: "MEMORY.md",
    title: "CLIs",
    body: "Prefers Go + kong for CLIs.",
  },
  {
    sourceId: "codex",
    path: "AGENTS.md",
    title: "CLIs again",
    body: "Go single-binary for agent CLIs.",
  },
];

describe("seedOperatorMemory", () => {
  test("synthesizes injected harness memories into written facts (fresh, not a copy)", async () => {
    const { repo, cleanup } = tmpRepo();
    try {
      // Injected invoker stands in for `claude --print` — returns a fenced JSON
      // block of synthesized facts (deduped across the two harness docs).
      const invoke = async (prompt: string) => {
        // the prompt must carry both harness docs as synthesis input
        expect(prompt).toContain("Prefers Go + kong");
        expect(prompt).toContain("single-binary");
        return '```json\n{"facts":[{"name":"prefers-go-kong-clis","description":"Go + kong for CLIs","type":"user","body":"Single binary, fast cold-start."}]}\n```';
      };

      const result = await seedOperatorMemory(repo, { memories: DOCS, invoke });
      expect(result).toEqual({
        memoriesRead: 2,
        sources: ["claude-code", "codex"],
        factsWritten: 1,
      });

      const facts = await listMemoryFacts(repo);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.name).toBe("prefers-go-kong-clis");
      expect(facts[0]?.type).toBe("user");
    } finally {
      cleanup();
    }
  });

  test("no harness memories → no-op (no invoke, nothing written)", async () => {
    const { repo, cleanup } = tmpRepo();
    try {
      let invoked = false;
      const result = await seedOperatorMemory(repo, {
        memories: [],
        invoke: async () => {
          invoked = true;
          return "{}";
        },
      });
      expect(result.factsWritten).toBe(0);
      expect(invoked).toBe(false);
      expect(await listMemoryFacts(repo)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("invalid/duplicate facts are dropped during validation", async () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const invoke = async () =>
        '```json\n{"facts":[' +
        '{"name":"a","description":"first","type":"feedback","body":"b1"},' +
        '{"name":"a","description":"dup slug","type":"user","body":"b2"},' + // dup slug → dropped
        '{"description":"","body":"no desc"},' + // empty desc → dropped
        '{"name":"c","description":"weird type","type":"bogus","body":"b3"}' + // bad type → coerced to feedback
        "]}\n```";
      const result = await seedOperatorMemory(repo, { memories: DOCS, invoke });
      expect(result.factsWritten).toBe(2); // "a" + "c"
      const facts = await listMemoryFacts(repo);
      expect(facts.map((f) => f.name).sort()).toEqual(["a", "c"]);
      expect(facts.find((f) => f.name === "c")?.type).toBe("feedback"); // coerced
    } finally {
      cleanup();
    }
  });
});

describe("buildSeedPrompt", () => {
  test("frames synthesis-not-copy and embeds the docs", () => {
    const p = buildSeedPrompt(DOCS);
    expect(p).toContain("SYNTHESIZE");
    expect(p).toContain("NOT copying");
    expect(p).toContain("[claude-code] CLIs");
    expect(p).toContain('"facts"');
  });
});
