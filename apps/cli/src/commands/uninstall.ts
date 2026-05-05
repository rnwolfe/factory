import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

import { run } from "../lib/exec.ts";
import { unitPath } from "../lib/unit.ts";

export async function runUninstall(): Promise<number> {
  const unitFile = unitPath();
  const systemctl = process.env.FACTORY_CLI_SYSTEMCTL || "systemctl";

  if (existsSync(unitFile)) {
    // Best-effort disable+stop. Both can fail (already-stopped, etc.); we
    // surface the error but keep going so the unit file always gets removed.
    const disable = await run([systemctl, "--user", "disable", "--now", "factory"]);
    if (disable.exitCode !== 0) {
      process.stderr.write(`factory: disable --now reported: ${disable.stderr.trim()}\n`);
    }
    await unlink(unitFile);
    process.stdout.write(`factory: removed ${unitFile}\n`);
    const reload = await run([systemctl, "--user", "daemon-reload"]);
    if (reload.exitCode !== 0) {
      process.stderr.write(`factory: daemon-reload failed: ${reload.stderr.trim()}\n`);
      return 1;
    }
  } else {
    process.stdout.write(`factory: nothing to remove (no unit at ${unitFile})\n`);
  }
  process.stdout.write("factory: ~/.factory/ left untouched (delete manually if desired)\n");
  return 0;
}
