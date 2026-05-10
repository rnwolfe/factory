import { run } from "../lib/exec.ts";

/**
 * Run the db seed via the workspace's existing script. Idempotent: seed
 * inserts only when the keyed row is missing, then updates the active flag.
 * Safe to run on every upgrade — picks up new prompts/rubrics shipped by
 * a release without clobbering operator-edited rows.
 *
 * The seed script reads its target DB from FACTORY_DB → FACTORY_HOME →
 * default. The upgrade caller passes `env.FACTORY_HOME` resolved from the
 * systemd unit file so the seed always hits the live daemon's DB even
 * when the operator's interactive shell doesn't export FACTORY_HOME.
 * (Without this override, the seed targets `~/factory/data.db` and
 * silently leaves the live DB with stale prompts and rubrics — that's
 * the regression that surfaced in v0.5.0 when push notifications failed
 * against a live DB whose seed had never targeted it.)
 */
export async function runSeed(
  checkout: string,
  bunBin: string,
  env: Record<string, string | undefined> = {},
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "seed"], { cwd: checkout, env });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
