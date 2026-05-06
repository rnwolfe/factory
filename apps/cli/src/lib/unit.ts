import os from "node:os";
import path from "node:path";

export const UNIT_FILENAME = "factory.service";

/**
 * Where the user-systemd unit lives. Honors XDG_CONFIG_HOME so tests can
 * point at a temp dir.
 */
export function unitDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user");
}

export function unitPath(): string {
  return path.join(unitDir(), UNIT_FILENAME);
}

export interface UnitVars {
  checkout: string;
  factoryHome: string;
  bunBin: string;
}

/**
 * Render the unit file. Type=notify because the daemon calls sd_notify
 * READY=1 once it's actually serving — that gives systemd (and the
 * post-upgrade health probe) a real readiness signal instead of "process
 * exec'd."
 *
 * NotifyAccess=all because `bun run --cwd <checkout> start` exec-chains
 * through `bun run --filter @factory/daemon start` to `bun src/index.ts`
 * — the actual daemon is a grandchild, not the unit's main PID.
 */
export function renderUnit(vars: UnitVars): string {
  return `[Unit]
Description=Factory daemon
After=network-online.target

[Service]
Type=notify
NotifyAccess=all
WorkingDirectory=${vars.checkout}
Environment=FACTORY_HOME=${vars.factoryHome}
ExecStart=${vars.bunBin} run --cwd ${vars.checkout} start
Restart=on-failure
RestartSec=2
TimeoutStartSec=60

[Install]
WantedBy=default.target
`;
}
