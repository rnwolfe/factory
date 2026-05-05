import { spawn as bunSpawn } from "bun";

const UNIT = "factory";

/**
 * One-shot read of recent journal entries for the factory unit. For
 * `logs -f`, callers should use `execJournalFollow` so Ctrl-C is handled
 * by journalctl itself.
 */
export async function readJournal(args: { lines: number; since?: string }): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const cmd = process.env.FACTORY_CLI_JOURNALCTL || "journalctl";
  const argv = [cmd, "--user", "-u", UNIT, "-n", String(args.lines), "--no-pager"];
  if (args.since) argv.push("--since", args.since);
  const proc = bunSpawn({
    cmd: argv,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

/**
 * Spawn `journalctl -f` and inherit stdio so Ctrl-C terminates it natively.
 * Returns the exit code.
 */
export async function execJournalFollow(args: { since?: string }): Promise<number> {
  const cmd = process.env.FACTORY_CLI_JOURNALCTL || "journalctl";
  const argv = [cmd, "--user", "-u", UNIT, "-f"];
  if (args.since) argv.push("--since", args.since);
  const proc = bunSpawn({
    cmd: argv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return await proc.exited;
}
