import { spawn as bunSpawn } from "bun";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Generic external-binary runner with stdout/stderr captured. */
export async function run(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  try {
    const proc = bunSpawn({
      cmd: argv,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } catch (err) {
    // Bun throws ENOENT when the binary isn't on PATH. Surface as exit 127
    // so callers (whichBin, install probes) can treat it as "missing".
    return { exitCode: 127, stdout: "", stderr: (err as Error).message };
  }
}

/**
 * Resolve a binary on PATH using `which`. Returns null if not found.
 * Test-friendly seam over Bun's process spawn.
 */
export async function whichBin(name: string): Promise<string | null> {
  const r = await run(["which", name]);
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}
