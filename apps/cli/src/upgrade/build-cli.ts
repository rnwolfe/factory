import { run } from "../lib/exec.ts";

/**
 * Recompile the operator-facing CLI bundle (`apps/cli/dist/factory`).
 * The shipped install creates `~/.local/bin/factory` as a symlink to
 * that path, so replacing the dist file picks up CLI fixes on the
 * operator's NEXT invocation. Without this step, a CLI bug-fix shipped
 * in a release stays dormant: the running upgrade process is itself the
 * old binary, and the symlink keeps pointing at the stale dist file
 * forever — the bug fix never reaches the operator.
 *
 * Linux happily replaces an executable while a process is running it
 * (the running process holds the old inode open via its open
 * file-descriptor; the path now resolves to the new file). So
 * rebuilding mid-upgrade is safe — the running upgrade finishes with
 * the old code, and the next `factory <anything>` invocation runs the
 * new code.
 */
export async function buildCli(
  checkout: string,
  bunBin: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "--filter", "@factory/cli", "build"], { cwd: checkout });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
