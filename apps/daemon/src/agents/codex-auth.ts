import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lightweight probe for whether the codex CLI is logged in for the current
 * user. Used at run-spawn time to refuse codex submissions before a worktree
 * is created, instead of letting the agent boot into the worktree and emit
 * "Authentication required" mid-run.
 *
 * The codex CLI writes `~/.codex/auth.json` on first `codex login` (browser
 * OAuth flow). Subsequent non-interactive daemon invocations read this file
 * without prompting. Presence is a sufficient signal for "this host has been
 * authed at least once" — a much faster probe than spawning `codex login
 * status`, which has cold-start cost and would run on every submit.
 *
 * If the file exists but the token has expired (rare; ChatGPT subscription
 * tokens are long-lived), the agent will still surface "Authentication
 * required" mid-run. That's a degradation, not a regression — the same
 * outcome the pre-precheck behavior had. The fast-path here catches the
 * common case (operator never ran `codex login` on this host) cheaply.
 *
 * `CODEX_HOME` overrides the credentials directory (codex CLI honors it).
 * Defaults to `~/.codex` per upstream convention.
 */
export interface CodexAuthStatus {
  ok: boolean;
  authPath: string;
  reason: string | null;
}

export function probeCodexAuth(): CodexAuthStatus {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const authPath = path.join(home, "auth.json");
  if (!existsSync(authPath)) {
    return {
      ok: false,
      authPath,
      reason: `${authPath} missing — run \`codex login\` as the user the factory daemon runs as`,
    };
  }
  try {
    const st = statSync(authPath);
    if (st.size === 0) {
      return {
        ok: false,
        authPath,
        reason: `${authPath} is empty — re-run \`codex login\``,
      };
    }
  } catch (err) {
    return {
      ok: false,
      authPath,
      reason: (err as Error).message,
    };
  }
  return { ok: true, authPath, reason: null };
}
