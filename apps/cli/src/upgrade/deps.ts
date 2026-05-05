import { run } from "../lib/exec.ts";

/**
 * Run `bun install --frozen-lockfile` only if the lockfile changed across
 * the upgrade (caller compares pre/post HEAD:bun.lock shas). Skipping
 * unnecessary installs keeps upgrades fast and avoids touching node_modules.
 */
export async function bunInstall(
  checkout: string,
  bunBin: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "install", "--frozen-lockfile"], { cwd: checkout });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
