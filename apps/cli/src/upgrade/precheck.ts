import { run } from "../lib/exec.ts";

export interface DirtyState {
  dirty: boolean;
  reason: string | null;
}

/**
 * `factory upgrade` refuses dirty checkouts so the operator can't accidentally
 * checkout a different sha and lose work-in-progress. --force overrides.
 */
export async function checkClean(checkout: string): Promise<DirtyState> {
  const status = await run(["git", "status", "--porcelain=v1", "-uall"], { cwd: checkout });
  if (status.exitCode !== 0) {
    return { dirty: true, reason: `git status failed: ${status.stderr.trim()}` };
  }
  const dirty = status.stdout.trim().length > 0;
  return {
    dirty,
    reason: dirty ? `working tree has uncommitted/untracked changes` : null,
  };
}

export async function currentHead(checkout: string): Promise<string> {
  const r = await run(["git", "rev-parse", "HEAD"], { cwd: checkout });
  if (r.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export async function lockfileSha(checkout: string): Promise<string | null> {
  const r = await run(["git", "rev-parse", "HEAD:bun.lock"], { cwd: checkout });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}
