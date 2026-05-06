import { fmtUptime, probeHealth } from "../lib/health-probe.ts";
import { isUnitNotFound, systemctl } from "../lib/systemctl.ts";

export async function runStatus(): Promise<number> {
  const res = await systemctl("status", "--no-pager");
  if (isUnitNotFound(res)) {
    process.stderr.write("factory: unit not installed. run `factory install` first.\n");
    return 2;
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  // Layer a /health probe on top — tells the operator whether the daemon
  // is *actually serving*, not just whether the unit is active.
  const probe = await probeHealth();
  process.stdout.write("\n");
  if (probe.status === "unreachable") {
    process.stdout.write(`/health  unreachable (${probe.error ?? "no response"})\n`);
  } else {
    process.stdout.write(
      `/health  ${probe.status}  version=${probe.version ?? "?"}  uptime=${
        probe.uptime_ms != null ? fmtUptime(probe.uptime_ms) : "?"
      }  active runs=${probe.active_runs ?? "?"}  sessions=${probe.active_sessions ?? "?"}\n`,
    );
  }
  // `systemctl status` exits non-zero when the unit is inactive — that's
  // informational, not an error from the CLI's perspective.
  return 0;
}
