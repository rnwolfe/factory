import { run } from "../lib/exec.ts";

/**
 * Detached-HEAD checkout of the resolved channel sha. We deliberately do
 * not use a branch — channels are sha pointers; the operator who wants a
 * branch creates one explicitly.
 */
export async function checkoutSha(checkout: string, sha: string): Promise<void> {
  const r = await run(["git", "checkout", "--quiet", "--detach", sha], { cwd: checkout });
  if (r.exitCode !== 0) {
    throw new Error(`git checkout ${sha}: ${r.stderr.trim()}`);
  }
}
