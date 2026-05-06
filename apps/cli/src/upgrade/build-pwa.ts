import { run } from "../lib/exec.ts";

/**
 * Build the PWA static bundle. The daemon's static handler caches
 * `existsSync(distRoot)` at construction time, so a missing or stale
 * dist would silently break the SPA until the next process restart.
 * Always (re)build before the daemon (re)starts.
 */
export async function buildPwa(
  checkout: string,
  bunBin: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "--filter", "@factory/pwa", "build"], { cwd: checkout });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
