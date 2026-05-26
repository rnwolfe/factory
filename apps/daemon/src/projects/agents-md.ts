import { existsSync, lstatSync } from "node:fs";
import { readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve the canonical instruction-file path for a project. Returns the
 * existing `AGENTS.md` path if either file exists; otherwise the path where
 * `AGENTS.md` *should* live (so writers can use it as a destination).
 *
 * Readers should call this and then `readIfPresent` to load the content —
 * both `AGENTS.md` (canonical) and `CLAUDE.md` (legacy / Claude-Code-only
 * symlink) resolve to the same bytes on a healthy project.
 */
export function agentsMdPath(workdirPath: string): string {
  return path.join(workdirPath, "AGENTS.md");
}

export function legacyClaudeMdPath(workdirPath: string): string {
  return path.join(workdirPath, "CLAUDE.md");
}

/**
 * Ensure `CLAUDE.md` is a symlink to `AGENTS.md` in this workdir. Idempotent:
 *
 * - No CLAUDE.md, no AGENTS.md: caller is about to write AGENTS.md, no-op.
 * - No CLAUDE.md, AGENTS.md exists: create the symlink.
 * - CLAUDE.md is already a symlink: leave it.
 * - CLAUDE.md is a regular file (legacy project), AGENTS.md doesn't exist:
 *   migrate by renaming CLAUDE.md → AGENTS.md, then symlink CLAUDE.md →
 *   AGENTS.md. Single source of truth restored.
 * - Both CLAUDE.md (regular file) and AGENTS.md exist: drift the caller can't
 *   safely resolve — leave both alone and let the operator pick which one
 *   wins. We don't clobber.
 */
export async function ensureClaudeMdSymlink(workdirPath: string): Promise<void> {
  const claude = legacyClaudeMdPath(workdirPath);
  const agents = agentsMdPath(workdirPath);
  const claudeExists = existsSync(claude);
  const claudeIsSymlink = claudeExists && lstatSync(claude).isSymbolicLink();
  const agentsExists = existsSync(agents);

  if (claudeIsSymlink) return;

  if (!claudeExists && agentsExists) {
    await symlink("AGENTS.md", claude);
    return;
  }

  if (claudeExists && !agentsExists) {
    // Legacy migration: rename CLAUDE.md → AGENTS.md, then drop the symlink.
    await rename(claude, agents);
    await symlink("AGENTS.md", claude);
    return;
  }

  // Both exist as separate regular files, or both absent — caller's
  // responsibility either way.
}

/**
 * Read the project's agent-instruction file. Prefers `AGENTS.md`; falls back
 * to `CLAUDE.md` for legacy projects that haven't been migrated yet. Returns
 * `null` when neither file is present (which is fine for tinker projects
 * that never authored a vision or imported a spec).
 *
 * On healthy migrated projects both paths resolve to the same bytes because
 * `CLAUDE.md` is a symlink to `AGENTS.md` — this function still prefers
 * `AGENTS.md` so the new convention is the explicit primary.
 */
export async function readAgentInstructions(workdirPath: string): Promise<string | null> {
  const agents = agentsMdPath(workdirPath);
  if (existsSync(agents)) {
    try {
      return await readFile(agents, "utf8");
    } catch {
      // fall through to legacy
    }
  }
  const claude = legacyClaudeMdPath(workdirPath);
  if (existsSync(claude)) {
    try {
      return await readFile(claude, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}
