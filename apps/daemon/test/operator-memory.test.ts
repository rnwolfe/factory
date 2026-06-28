import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureMemoryRepo,
  listMemoryFacts,
  operatorMemoryPointer,
  readMemoryIndex,
  slugify,
  writeMemoryFact,
} from "../src/memory/operator-memory.ts";
import { wrapPrompt } from "../src/workers/factory-status.ts";

function tmp(): { repo: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "operator-memory-"));
  return {
    repo: path.join(root, "operator-memory"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("slugify", () => {
  test("kebab-cases and bounds", () => {
    expect(slugify("Scaffolds CLIs by Hand!")).toBe("scaffolds-clis-by-hand");
    expect(slugify("   ")).toBe("fact");
  });
});

describe("operator-memory store", () => {
  test("ensureMemoryRepo inits a git repo with a MEMORY.md", async () => {
    const { repo, cleanup } = tmp();
    try {
      await ensureMemoryRepo(repo);
      expect(existsSync(path.join(repo, ".git"))).toBe(true);
      expect(existsSync(path.join(repo, "MEMORY.md"))).toBe(true);
      await ensureMemoryRepo(repo); // idempotent
    } finally {
      cleanup();
    }
  });

  test("writeMemoryFact persists a frontmatter fact, indexes it, and is readable", async () => {
    const { repo, cleanup } = tmp();
    try {
      await writeMemoryFact(repo, {
        name: "scaffolds-clis-by-hand",
        description: "Builds agent-CLIs on a shared reusable API layer",
        type: "feedback",
        body: "Across sessions the operator factors CLI work around one API layer.",
        provenance: ["watch:obs1", "claude-code/abc12345"],
      });

      const facts = await listMemoryFacts(repo);
      expect(facts).toHaveLength(1);
      const f = facts[0];
      if (!f) throw new Error("expected one fact");
      expect(f.name).toBe("scaffolds-clis-by-hand");
      expect(f.type).toBe("feedback");
      expect(f.body).toContain("one API layer");
      expect(f.provenance).toEqual(["watch:obs1", "claude-code/abc12345"]);

      // MEMORY.md index links the fact under its type section.
      const index = await readMemoryIndex(repo);
      expect(index).toContain("## Feedback");
      expect(index).toContain("[scaffolds-clis-by-hand](scaffolds-clis-by-hand.md)");

      // a second fact of another type → both indexed, sections rebuilt
      await writeMemoryFact(repo, {
        name: "prefers-go-kong",
        description: "Prefers Go + kong for agent CLIs",
        type: "user",
        body: "Fast cold-start, single binary.",
      });
      const facts2 = await listMemoryFacts(repo);
      expect(facts2.map((x) => x.name).sort()).toEqual([
        "prefers-go-kong",
        "scaffolds-clis-by-hand",
      ]);
      const index2 = await readMemoryIndex(repo);
      expect(index2).toContain("## User");
      expect(index2).toContain("## Feedback");
    } finally {
      cleanup();
    }
  });
});

describe("operatorMemoryPointer (run-context injection)", () => {
  test("is empty for a fresh/absent repo, populated once facts exist", async () => {
    const { repo, cleanup } = tmp();
    try {
      // absent repo → no pointer (a no-op for fresh installs)
      expect(await operatorMemoryPointer(repo)).toBe("");

      await writeMemoryFact(repo, {
        name: "prefers-go-kong",
        description: "Prefers Go + kong for agent CLIs",
        type: "user",
        body: "Fast cold-start, single binary.",
      });

      const pointer = await operatorMemoryPointer(repo);
      expect(pointer).toContain("Operator memory");
      expect(pointer).toContain("MEMORY.md"); // points at the index, not inlined
      expect(pointer).toContain("1 recorded"); // the count
      // It's a pointer, not a doctrine prepend — the fact body is NOT inlined.
      expect(pointer).not.toContain("single binary");
    } finally {
      cleanup();
    }
  });

  test("wrapPrompt threads the pointer in without disturbing the footer", () => {
    const refs = "\n\n---\n\n## Operator memory (reading list)\n\nsee MEMORY.md\n";
    const wrapped = wrapPrompt("do the thing", "collaborative", refs);
    expect(wrapped).toContain("do the thing");
    expect(wrapped).toContain("## Operator memory (reading list)");
    // still carries the completion-protocol footer
    expect(wrapped.toLowerCase()).toContain("factory-status");
    // empty refs (the default) leaves the prompt unchanged from no-arg form
    expect(wrapPrompt("do the thing", "collaborative")).toBe(
      wrapPrompt("do the thing", "collaborative", ""),
    );
  });
});
