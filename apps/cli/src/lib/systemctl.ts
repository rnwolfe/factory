import { spawn as bunSpawn } from "bun";

export interface SystemctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const UNIT = "factory";
const NOT_FOUND_RE = /Unit .* could not be found|not loaded\./i;

/**
 * Run `systemctl --user <verb> factory[.service]` and return the result.
 * Test seam: `FACTORY_CLI_SYSTEMCTL` overrides the command name (e.g. point
 * at a fake script that records argv to a file).
 */
export async function systemctl(verb: string, ...extra: string[]): Promise<SystemctlResult> {
  const cmd = process.env.FACTORY_CLI_SYSTEMCTL || "systemctl";
  const proc = bunSpawn({
    cmd: [cmd, "--user", verb, UNIT, ...extra],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

export function isUnitNotFound(res: SystemctlResult): boolean {
  return NOT_FOUND_RE.test(res.stderr) || NOT_FOUND_RE.test(res.stdout);
}

/** Convenience wrapper: print stderr, return appropriate exit code. */
export function emitResult(res: SystemctlResult): number {
  if (isUnitNotFound(res)) {
    process.stderr.write("factory: unit not installed. run `factory install` first.\n");
    return 2;
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode === 0 ? 0 : 1;
}
