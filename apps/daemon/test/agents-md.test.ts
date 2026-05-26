import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentsMdPath,
  ensureClaudeMdSymlink,
  legacyClaudeMdPath,
  readAgentInstructions,
} from "../src/projects/agents-md.ts";

function mkTemp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("ensureClaudeMdSymlink", () => {
  test("creates CLAUDE.md as a symlink when AGENTS.md exists and CLAUDE.md doesn't", async () => {
    const dir = mkTemp("factory-agents-md-fresh-");
    try {
      writeFileSync(agentsMdPath(dir), "# Agents\n", "utf8");
      expect(existsSync(legacyClaudeMdPath(dir))).toBe(false);

      await ensureClaudeMdSymlink(dir);

      expect(lstatSync(legacyClaudeMdPath(dir)).isSymbolicLink()).toBe(true);
      expect(readFileSync(legacyClaudeMdPath(dir), "utf8")).toBe("# Agents\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrates legacy regular-file CLAUDE.md → AGENTS.md + symlink", async () => {
    const dir = mkTemp("factory-agents-md-legacy-");
    try {
      writeFileSync(legacyClaudeMdPath(dir), "# Legacy CLAUDE\n", "utf8");
      expect(existsSync(agentsMdPath(dir))).toBe(false);

      await ensureClaudeMdSymlink(dir);

      expect(existsSync(agentsMdPath(dir))).toBe(true);
      expect(readFileSync(agentsMdPath(dir), "utf8")).toBe("# Legacy CLAUDE\n");
      expect(lstatSync(legacyClaudeMdPath(dir)).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when CLAUDE.md is already a symlink", async () => {
    const dir = mkTemp("factory-agents-md-idem-");
    try {
      writeFileSync(agentsMdPath(dir), "# Agents\n", "utf8");
      symlinkSync("AGENTS.md", legacyClaudeMdPath(dir));
      const before = lstatSync(legacyClaudeMdPath(dir)).mtimeMs;

      await ensureClaudeMdSymlink(dir);

      const after = lstatSync(legacyClaudeMdPath(dir)).mtimeMs;
      expect(after).toBe(before);
      expect(lstatSync(legacyClaudeMdPath(dir)).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves both files alone when both exist as regular files (operator drift)", async () => {
    const dir = mkTemp("factory-agents-md-drift-");
    try {
      writeFileSync(agentsMdPath(dir), "# Agents\n", "utf8");
      writeFileSync(legacyClaudeMdPath(dir), "# Different CLAUDE\n", "utf8");

      await ensureClaudeMdSymlink(dir);

      // Neither got clobbered.
      expect(lstatSync(legacyClaudeMdPath(dir)).isSymbolicLink()).toBe(false);
      expect(readFileSync(agentsMdPath(dir), "utf8")).toBe("# Agents\n");
      expect(readFileSync(legacyClaudeMdPath(dir), "utf8")).toBe("# Different CLAUDE\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readAgentInstructions", () => {
  test("prefers AGENTS.md when both AGENTS.md and a legacy CLAUDE.md exist as regular files", async () => {
    const dir = mkTemp("factory-agents-md-read-prefer-");
    try {
      writeFileSync(agentsMdPath(dir), "# Agents wins\n", "utf8");
      writeFileSync(legacyClaudeMdPath(dir), "# Stale CLAUDE\n", "utf8");
      const got = await readAgentInstructions(dir);
      expect(got).toBe("# Agents wins\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to CLAUDE.md when only legacy file exists", async () => {
    const dir = mkTemp("factory-agents-md-read-fallback-");
    try {
      writeFileSync(legacyClaudeMdPath(dir), "# Legacy only\n", "utf8");
      const got = await readAgentInstructions(dir);
      expect(got).toBe("# Legacy only\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when neither file exists", async () => {
    const dir = mkTemp("factory-agents-md-read-none-");
    try {
      expect(await readAgentInstructions(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
