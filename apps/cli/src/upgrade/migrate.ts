import { run } from "../lib/exec.ts";

/** Run drizzle migrations via the existing top-level npm script. */
export async function runMigrations(
  checkout: string,
  bunBin: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await run([bunBin, "run", "db:migrate"], { cwd: checkout });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
