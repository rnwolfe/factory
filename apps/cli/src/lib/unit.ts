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
 * Render the unit file. cut 2 ships Type=simple; cut 3 will flip this to
 * Type=notify after the daemon's sd_notify call lands.
 */
export function renderUnit(vars: UnitVars): string {
  return `[Unit]
Description=Factory daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${vars.checkout}
Environment=FACTORY_HOME=${vars.factoryHome}
ExecStart=${vars.bunBin} run --cwd ${vars.checkout} start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}
