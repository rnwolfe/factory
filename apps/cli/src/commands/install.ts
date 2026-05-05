import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { run, whichBin } from "../lib/exec.ts";
import { renderUnit, unitDir, unitPath } from "../lib/unit.ts";

export interface InstallArgs {
  checkout: string | undefined;
  home: string | undefined;
  force: boolean;
  yes: boolean;
}

export function parseInstallArgs(argv: string[]): InstallArgs {
  let checkout: string | undefined;
  let home: string | undefined;
  let force = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--checkout") checkout = argv[++i];
    else if (a?.startsWith("--checkout=")) checkout = a.slice("--checkout=".length);
    else if (a === "--home") home = argv[++i];
    else if (a?.startsWith("--home=")) home = a.slice("--home=".length);
  }
  return { checkout, home, force, yes };
}

async function detectCheckout(arg: string | undefined): Promise<string> {
  if (arg) return path.resolve(arg);
  const r = await run(["git", "rev-parse", "--show-toplevel"]);
  if (r.exitCode !== 0) {
    throw new Error("not inside a git repo and no --checkout given");
  }
  return r.stdout.trim();
}

async function isFactoryRepo(checkout: string): Promise<boolean> {
  const pkgPath = path.join(checkout, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return pkg?.name === "factory";
  } catch {
    return false;
  }
}

async function detectBun(): Promise<string> {
  const cmd = process.env.FACTORY_CLI_BUN || (await whichBin("bun"));
  if (!cmd) {
    throw new Error("bun not found on PATH");
  }
  return cmd;
}

async function detectSystemctl(): Promise<string> {
  return process.env.FACTORY_CLI_SYSTEMCTL || (await whichBin("systemctl")) || "systemctl";
}

async function detectLoginctl(): Promise<string | null> {
  if (process.env.FACTORY_CLI_LOGINCTL) return process.env.FACTORY_CLI_LOGINCTL;
  return await whichBin("loginctl");
}

async function promptYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  const buf = new Uint8Array(64);
  // biome-ignore lint/suspicious/noExplicitAny: bun types narrow stdin reads
  const n = await ((process.stdin as any).read?.(buf) ?? Promise.resolve(0));
  if (!n) return false;
  const ans = new TextDecoder()
    .decode(buf.slice(0, Number(n)))
    .trim()
    .toLowerCase();
  return ans === "y" || ans === "yes";
}

export async function runInstall(args: InstallArgs): Promise<number> {
  let checkout: string;
  try {
    checkout = await detectCheckout(args.checkout);
  } catch (err) {
    process.stderr.write(`factory: ${(err as Error).message}\n`);
    return 1;
  }
  if (!(await isFactoryRepo(checkout))) {
    process.stderr.write(`factory: ${checkout} does not look like a Factory checkout\n`);
    return 1;
  }
  const factoryHome = args.home ? path.resolve(args.home) : path.join(os.homedir(), ".factory");

  let bunBin: string;
  try {
    bunBin = await detectBun();
  } catch (err) {
    process.stderr.write(`factory: ${(err as Error).message}\n`);
    return 1;
  }

  const unitFile = unitPath();
  if (existsSync(unitFile) && !args.force) {
    process.stderr.write(
      `factory: unit already exists at ${unitFile}\n  re-run with --force to overwrite, or \`factory uninstall\` first\n`,
    );
    return 1;
  }

  await mkdir(unitDir(), { recursive: true });
  const content = renderUnit({ checkout, factoryHome, bunBin });
  await writeFile(unitFile, content, "utf8");
  process.stdout.write(`factory: wrote ${unitFile}\n`);

  const systemctl = await detectSystemctl();
  const loginctl = await detectLoginctl();

  // enable-linger so the daemon survives logout. Gated on operator consent.
  if (loginctl) {
    let enableLinger = args.yes;
    if (!enableLinger && !args.yes) {
      enableLinger = await promptYes(
        "enable systemd lingering for $USER? (lets the daemon stay up across logout)",
      );
    }
    if (enableLinger) {
      const lingerRes = await run([loginctl, "enable-linger", os.userInfo().username]);
      if (lingerRes.exitCode === 0) {
        process.stdout.write("factory: linger enabled\n");
      } else {
        process.stderr.write(
          `factory: loginctl enable-linger failed (${lingerRes.stderr.trim()}); continuing\n`,
        );
      }
    }
  } else {
    process.stderr.write(
      "factory: loginctl not found — skipping enable-linger; daemon will stop on logout\n",
    );
  }

  const reload = await run([systemctl, "--user", "daemon-reload"]);
  if (reload.exitCode !== 0) {
    process.stderr.write(`factory: daemon-reload failed: ${reload.stderr.trim()}\n`);
    return 1;
  }
  const enable = await run([systemctl, "--user", "enable", "--now", "factory"]);
  if (enable.exitCode !== 0) {
    process.stderr.write(`factory: enable --now failed: ${enable.stderr.trim()}\n`);
    return 1;
  }
  process.stdout.write("factory: enabled and started\n");
  return 0;
}
