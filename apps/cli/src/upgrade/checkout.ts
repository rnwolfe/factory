import { run } from "../lib/exec.ts";

/**
 * Move the checkout to the resolved channel sha.
 *
 * Channels are sha pointers internally, but landing on a detached HEAD
 * has a real downstream cost: any Factory project whose workdir IS the
 * upgrade checkout (the common single-host operator setup) ends up with
 * a detached project HEAD, and `mergeIntoMain` refuses to merge run
 * branches into a detached target. Every upgrade then silently breaks
 * the next merge until the operator notices and re-attaches manually.
 *
 * So when the operator was on a named branch before the upgrade, we
 * try to fast-forward that branch to the target sha and stay on it.
 * That preserves the sha-pointer semantics (HEAD still ends up at the
 * requested sha) while keeping the operator on the branch they were on.
 *
 * Three cases:
 *   - Operator was on a branch that fast-forwards to the target → stay
 *     on the branch (FF advances it to the sha).
 *   - Operator was on a branch with local commits not on the target
 *     (non-FF) → detach. The local commits stay reachable from the
 *     branch ref; the tree matches the target sha.
 *   - Operator was already detached → leave them detached.
 */
export async function checkoutSha(checkout: string, sha: string): Promise<void> {
  const headSym = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: checkout });
  const branchBefore = headSym.exitCode === 0 ? headSym.stdout.trim() : null;

  if (branchBefore) {
    const ff = await run(["git", "merge", "--ff-only", "--quiet", sha], { cwd: checkout });
    if (ff.exitCode === 0) return;
    // Fall through: branch has local commits beyond the target. Detach so
    // the tree matches the upgrade target; the operator's branch ref is
    // left where it was.
  }

  const detach = await run(["git", "checkout", "--quiet", "--detach", sha], { cwd: checkout });
  if (detach.exitCode !== 0) {
    throw new Error(`git checkout ${sha}: ${detach.stderr.trim()}`);
  }
}
