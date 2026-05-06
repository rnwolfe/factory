import { execJournalFollow, readJournal } from "../lib/journal.ts";

export interface LogsArgs {
  follow: boolean;
  lines: number;
  since: string | undefined;
}

export async function runLogs(args: LogsArgs): Promise<number> {
  if (args.follow) {
    return execJournalFollow({ since: args.since });
  }
  const res = await readJournal({ lines: args.lines, since: args.since });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode === 0 ? 0 : 1;
}

export function parseLogsArgs(argv: string[]): LogsArgs {
  let follow = false;
  let lines = 100;
  let since: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--follow") {
      follow = true;
    } else if (a === "-n" || a === "--lines") {
      const v = argv[++i];
      if (v) lines = Math.max(1, Number.parseInt(v, 10) || lines);
    } else if (a?.startsWith("--lines=")) {
      lines = Math.max(1, Number.parseInt(a.slice(8), 10) || lines);
    } else if (a === "--since") {
      since = argv[++i];
    } else if (a?.startsWith("--since=")) {
      since = a.slice(8);
    }
  }
  return { follow, lines, since };
}
