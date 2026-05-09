import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readConfig } from "../lib/config.ts";
import { run, whichBin } from "../lib/exec.ts";
import { probeHealth } from "../lib/health-probe.ts";
import { isUnitNotFound, systemctl } from "../lib/systemctl.ts";
import { unitPath } from "../lib/unit.ts";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorArgs {
  strict: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  let strict = false;
  for (const a of argv) {
    if (a === "--strict") strict = true;
  }
  return { strict };
}

async function checkBun(): Promise<CheckResult> {
  const cmd = process.env.FACTORY_CLI_BUN || (await whichBin("bun"));
  if (!cmd) return { name: "bun", status: "fail", detail: "not on PATH" };
  const r = await run([cmd, "--version"]);
  if (r.exitCode !== 0) return { name: "bun", status: "fail", detail: r.stderr.trim() };
  return { name: "bun", status: "pass", detail: r.stdout.trim() };
}

async function checkGit(): Promise<CheckResult> {
  const r = await run(["git", "--version"]);
  if (r.exitCode !== 0) return { name: "git", status: "fail", detail: "not on PATH" };
  return { name: "git", status: "pass", detail: r.stdout.trim() };
}

function checkUnitFile(): CheckResult {
  const p = unitPath();
  if (!existsSync(p)) {
    return { name: "unit file", status: "fail", detail: `${p} missing — run \`factory install\`` };
  }
  return { name: "unit file", status: "pass", detail: p };
}

async function checkUnitActive(): Promise<CheckResult> {
  const r = await systemctl("is-active");
  if (isUnitNotFound(r)) {
    return { name: "unit active", status: "fail", detail: "unit not installed" };
  }
  const out = r.stdout.trim();
  if (out === "active") return { name: "unit active", status: "pass", detail: "active" };
  return { name: "unit active", status: "fail", detail: out || "inactive" };
}

async function checkHealth(): Promise<CheckResult> {
  const r = await probeHealth(2000);
  if (r.status === "unreachable") {
    return { name: "/health", status: "fail", detail: r.error ?? "unreachable" };
  }
  if (r.status === "degraded") {
    return { name: "/health", status: "warn", detail: "daemon reports degraded" };
  }
  return {
    name: "/health",
    status: "pass",
    detail: `version=${r.version ?? "?"}  active runs=${r.active_runs ?? "?"}  sessions=${
      r.active_sessions ?? "?"
    }`,
  };
}

async function checkConfig(): Promise<CheckResult> {
  try {
    const cfg = await readConfig();
    if (cfg.channel !== "stable" && cfg.channel !== "nightly" && cfg.channel !== "dev") {
      return { name: "config", status: "fail", detail: `unknown channel: ${cfg.channel}` };
    }
    return {
      name: "config",
      status: "pass",
      detail: `channel=${cfg.channel}  remote=${cfg.remote}`,
    };
  } catch (err) {
    return { name: "config", status: "fail", detail: (err as Error).message };
  }
}

async function checkLinger(): Promise<CheckResult> {
  const cmd = process.env.FACTORY_CLI_LOGINCTL || (await whichBin("loginctl"));
  if (!cmd) return { name: "linger", status: "warn", detail: "loginctl not found" };
  const r = await run([cmd, "show-user", os.userInfo().username, "--property=Linger"]);
  if (r.exitCode !== 0) {
    return { name: "linger", status: "warn", detail: r.stderr.trim() };
  }
  if (/Linger=yes/i.test(r.stdout)) {
    return { name: "linger", status: "pass", detail: "yes" };
  }
  return {
    name: "linger",
    status: "warn",
    detail: "no — daemon will stop on logout",
  };
}

async function checkRemote(): Promise<CheckResult> {
  const cfg = await readConfig();
  const checkout = cfg.checkout || process.cwd();
  const r = await run(["git", "remote", "get-url", cfg.remote], { cwd: checkout });
  if (r.exitCode !== 0) {
    return {
      name: "remote",
      status: "warn",
      detail: `no remote '${cfg.remote}' configured in ${checkout}`,
    };
  }
  return { name: "remote", status: "pass", detail: `${cfg.remote}=${r.stdout.trim()}` };
}

/**
 * Surface the daemon's configured bind host. The PWA on a phone or other
 * LAN device can only reach the daemon if it's bound to 0.0.0.0 (or a
 * specific external interface). A host of `127.0.0.1` / `localhost`
 * means localhost-only — diagnostically useful when "the PWA is
 * unreachable from my phone" reports come in.
 *
 * Reads the live daemon's config from <FACTORY_HOME>/config.yaml,
 * resolved by parsing `Environment=FACTORY_HOME=` from the systemd unit
 * file. Falls back to ~/.factory/config.yaml when the unit isn't
 * installed.
 */
async function checkBind(): Promise<CheckResult> {
  let factoryHome = process.env.FACTORY_HOME ?? path.join(os.homedir(), ".factory");
  if (existsSync(unitPath())) {
    try {
      const { readFile: rf } = await import("node:fs/promises");
      const unit = await rf(unitPath(), "utf8");
      const m = unit.match(/^Environment=FACTORY_HOME=(.+)$/m);
      if (m) factoryHome = (m[1] ?? "").trim();
    } catch {
      // best-effort
    }
  }
  const liveCfgPath = path.join(factoryHome, "config.yaml");
  if (!existsSync(liveCfgPath)) {
    return {
      name: "bind",
      status: "warn",
      detail: `${liveCfgPath} missing (daemon hasn't booted yet?)`,
    };
  }
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const yaml = await import("yaml");
    const text = await rf(liveCfgPath, "utf8");
    const parsed = yaml.parse(text) as { host?: unknown; port?: unknown } | null;
    const host = typeof parsed?.host === "string" ? parsed.host : "0.0.0.0";
    const port = typeof parsed?.port === "number" ? parsed.port : 4080;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return {
        name: "bind",
        status: "warn",
        detail: `host=${host}:${port} — LOCALHOST ONLY. set host: "0.0.0.0" in ${liveCfgPath} and restart for LAN access`,
      };
    }
    return { name: "bind", status: "pass", detail: `${host}:${port}` };
  } catch (err) {
    return { name: "bind", status: "warn", detail: (err as Error).message };
  }
}

async function checkDb(): Promise<CheckResult> {
  // Bun's built-in sqlite — open read-only and verify it's a valid db.
  const home = process.env.FACTORY_HOME || path.join(os.homedir(), ".factory");
  const dbPath = path.join(home, "data.db");
  if (!existsSync(dbPath)) {
    return { name: "db", status: "warn", detail: `${dbPath} missing (daemon hasn't booted yet?)` };
  }
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT count(*) as n FROM __drizzle_migrations").get() as {
      n: number;
    };
    db.close();
    return { name: "db", status: "pass", detail: `${row.n} migration(s) applied` };
  } catch (err) {
    return { name: "db", status: "fail", detail: (err as Error).message };
  }
}

function fmt(c: CheckResult): string {
  const sym = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
  const padName = c.name.padEnd(14);
  return `${sym}  ${padName}  ${c.detail}`;
}

export async function runDoctor(args: DoctorArgs): Promise<number> {
  const checks: CheckResult[] = [
    await checkBun(),
    await checkGit(),
    checkUnitFile(),
    await checkUnitActive(),
    await checkHealth(),
    await checkConfig(),
    await checkRemote(),
    await checkLinger(),
    await checkBind(),
    await checkDb(),
  ];
  for (const c of checks) process.stdout.write(`${fmt(c)}\n`);

  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  if (failed) return 1;
  if (warned && args.strict) return 1;
  return 0;
}
