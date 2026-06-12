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

/**
 * When any project (or the system default) selects codex, the operator needs
 * to have run `codex login` at least once or runs will fail at spawn time.
 * This check is silent when codex isn't in use anywhere; otherwise it
 * surfaces whether `~/.codex/auth.json` exists and the codex bin is on PATH.
 */
async function checkCodexAuth(): Promise<CheckResult | null> {
  const home = process.env.FACTORY_HOME || path.join(os.homedir(), ".factory");
  const dbPath = path.join(home, "data.db");
  let codexInUse = false;
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      try {
        const project = db
          .prepare("SELECT 1 AS n FROM projects WHERE agent = 'codex' LIMIT 1")
          .get() as { n: number } | undefined;
        if (project) codexInUse = true;
        if (!codexInUse) {
          const setting = db
            .prepare("SELECT value FROM settings WHERE key = 'default-agent' LIMIT 1")
            .get() as { value: string } | undefined;
          if (setting?.value === "codex") codexInUse = true;
        }
      } finally {
        db.close();
      }
    } catch {
      // db unreadable — checkDb will already have surfaced it
    }
  }
  if (!codexInUse) return null;

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  const codexBin = process.env.FACTORY_CLI_CODEX || (await whichBin("codex"));
  if (!codexBin) {
    return {
      name: "codex",
      status: "fail",
      detail: "codex selected but `codex` binary not on PATH — `npm i -g @openai/codex`",
    };
  }
  if (!existsSync(authPath)) {
    return {
      name: "codex",
      status: "fail",
      detail: `${authPath} missing — run \`codex login\` as the user the factory daemon runs as`,
    };
  }
  return { name: "codex", status: "pass", detail: `authed (${authPath})` };
}

/**
 * Surfaces whether the Factory GitHub App (ADR-007) is configured. Silent when
 * unconfigured. Reads the settings DB — the path the PWA / `settings.set`
 * writes; App credentials provided only via `config.yaml` won't show here.
 */
async function checkGithubApp(): Promise<CheckResult | null> {
  const home = process.env.FACTORY_HOME || path.join(os.homedir(), ".factory");
  const dbPath = path.join(home, "data.db");
  if (!existsSync(dbPath)) return null;
  let appId: string | undefined;
  let hasKey = false;
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const idRow = db
        .prepare("SELECT value FROM settings WHERE key = 'github-app-id' LIMIT 1")
        .get() as { value: string } | undefined;
      appId = idRow?.value;
      const keyRow = db
        .prepare("SELECT value FROM settings WHERE key = 'github-app-private-key' LIMIT 1")
        .get() as { value: string } | undefined;
      hasKey = Boolean(keyRow?.value);
    } finally {
      db.close();
    }
  } catch {
    return null; // db unreadable — checkDb already surfaces it
  }
  if (!appId) return null; // not configured — stay silent
  if (!hasKey) {
    return {
      name: "github-app",
      status: "warn",
      detail: `App id ${appId} set but no private key — set 'github-app-private-key'`,
    };
  }
  return { name: "github-app", status: "pass", detail: `App ${appId} configured` };
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
  const codex = await checkCodexAuth();
  if (codex) checks.push(codex);
  const ghApp = await checkGithubApp();
  if (ghApp) checks.push(ghApp);
  for (const c of checks) process.stdout.write(`${fmt(c)}\n`);

  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  if (failed) return 1;
  if (warned && args.strict) return 1;
  return 0;
}
