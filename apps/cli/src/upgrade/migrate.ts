import { run } from "../lib/exec.ts";

/**
 * Run drizzle migrations via the existing top-level npm script.
 *
 * The migrate script reads its target DB from FACTORY_DB → FACTORY_HOME →
 * default. The upgrade caller passes `env.FACTORY_HOME` resolved from the
 * systemd unit file so this always targets the live daemon's DB even
 * when the operator's interactive shell doesn't export FACTORY_HOME.
 * The daemon also re-runs migrations at boot, so a missed override here
 * was historically masked — but the matching `runSeed` call has no such
 * fallback, so we keep both subprocesses pointed at the same DB.
 */
export async function runMigrations(
  checkout: string,
  bunBin: string,
  env: Record<string, string | undefined> = {},
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "db:migrate"], { cwd: checkout, env });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
