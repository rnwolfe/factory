import { run } from "../lib/exec.ts";

/**
 * Run the db seed via the workspace's existing script. Idempotent: seed
 * inserts only when the keyed row is missing, then updates the active flag.
 * Safe to run on every upgrade — picks up new prompts/rubrics shipped by
 * a release without clobbering operator-edited rows.
 *
 * The seed script reads its target DB from FACTORY_DB → FACTORY_HOME →
 * default; the CLI inherits FACTORY_HOME from its own environment so the
 * subprocess hits the live daemon's DB.
 */
export async function runSeed(
  checkout: string,
  bunBin: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "seed"], { cwd: checkout });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
