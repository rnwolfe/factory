import { isUnitNotFound, systemctl } from "../lib/systemctl.ts";

export async function runStatus(): Promise<number> {
  const res = await systemctl("status", "--no-pager");
  if (isUnitNotFound(res)) {
    process.stderr.write("factory: unit not installed. run `factory install` first.\n");
    return 2;
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  // `systemctl status` exits non-zero when the unit is inactive — that's
  // informational, not an error from the CLI's perspective.
  return 0;
}
