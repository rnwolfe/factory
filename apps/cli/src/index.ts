#!/usr/bin/env bun
import { runDown } from "./commands/down.ts";
import { parseLogsArgs, runLogs } from "./commands/logs.ts";
import { runRestart } from "./commands/restart.ts";
import { runStatus } from "./commands/status.ts";
import { runUp } from "./commands/up.ts";
import { HELP } from "./help.ts";

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return cmd ? 0 : 0;
  }
  const rest = argv.slice(1);
  switch (cmd) {
    case "up":
      return await runUp();
    case "down":
      return await runDown();
    case "restart":
      return await runRestart();
    case "status":
      return await runStatus();
    case "logs":
      return await runLogs(parseLogsArgs(rest));
    default:
      process.stderr.write(`factory: unknown command '${cmd}'\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
