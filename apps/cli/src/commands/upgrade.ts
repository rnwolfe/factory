import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ChannelResolveError,
  type ResolvedChannel,
  resolveChannel,
  shortSha,
} from "../lib/channel.ts";
import { type Channel, readConfig } from "../lib/config.ts";
import { run, whichBin } from "../lib/exec.ts";
import { appendUpgradeLog, readLastGood, writeLastGood } from "../lib/state.ts";
import { systemctl } from "../lib/systemctl.ts";
import { unitPath } from "../lib/unit.ts";
import { buildCli } from "../upgrade/build-cli.ts";
import { buildPwa } from "../upgrade/build-pwa.ts";
import { checkoutSha } from "../upgrade/checkout.ts";
import { bunInstall } from "../upgrade/deps.ts";
import { runMigrations } from "../upgrade/migrate.ts";
import { checkClean, currentHead, lockfileSha } from "../upgrade/precheck.ts";
import { probeUntilVersion } from "../upgrade/probe.ts";
import { runSeed } from "../upgrade/seed.ts";

export interface UpgradeArgs {
  channel: Channel | undefined;
  checkout: string | undefined;
  dryRun: boolean;
  force: boolean;
  skipRestart: boolean;
  /** Operator asked for `--help` / `-h` — print and exit before any I/O. */
  help: boolean;
}

export function parseUpgradeArgs(argv: string[]): UpgradeArgs {
  let channel: Channel | undefined;
  let checkout: string | undefined;
  let dryRun = false;
  let force = false;
  let skipRestart = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--skip-restart") skipRestart = true;
    else if (a === "--channel") channel = argv[++i] as Channel;
    else if (a?.startsWith("--channel=")) channel = a.slice("--channel=".length) as Channel;
    else if (a === "--checkout") checkout = argv[++i];
    else if (a?.startsWith("--checkout=")) checkout = a.slice("--checkout=".length);
  }
  return { channel, checkout, dryRun, force, skipRestart, help };
}

const UPGRADE_HELP = `factory upgrade — fetch, checkout, install, migrate, restart, probe

usage:
  factory upgrade [options]

options:
  --channel=<n>    override the configured channel (stable | nightly | dev)
  --checkout=<p>   override the configured upgrade.checkout (must be a git
                   clone of the Factory repo, NOT the install dir)
  --dry-run        print the target sha and exit without applying
  --force          proceed on a dirty checkout (use sparingly)
  --skip-restart   apply changes but do not restart the systemd unit
  --help, -h       this message

config:
  upgrade.checkout is read from the CLI config (default
  ~/.factory/config.yaml). If unset, this command tries to auto-discover
  it from your installed factory.service unit's WorkingDirectory. If
  neither is available, you'll be prompted to set it — the simplest
  path is \`cd /path/to/factory && factory install --force\`, which
  persists the checkout into the CLI config.
`;

/**
 * Try to recover the dev checkout path from the systemd unit file. The
 * install command writes \`WorkingDirectory=<checkout>\` into the unit, so
 * if the operator's CLI config never persisted the checkout (e.g. they
 * installed before that fix landed), we can still find it. Returns null
 * if the unit doesn't exist or doesn't have a parseable WorkingDirectory.
 */
async function checkoutFromUnit(): Promise<string | null> {
  const p = unitPath();
  if (!existsSync(p)) return null;
  try {
    const text = await readFile(p, "utf8");
    const m = text.match(/^WorkingDirectory=(.+)$/m);
    if (!m) return null;
    const candidate = (m[1] ?? "").trim();
    return candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Recover the daemon's FACTORY_HOME from the systemd unit file. The
 * install command writes \`Environment=FACTORY_HOME=<path>\` into the
 * unit; that path is the daemon's data dir (where data.db, config.yaml,
 * and worktrees live). Without this resolution, the migrate + seed
 * subprocesses inherit only the operator's interactive shell env — which
 * typically does NOT export FACTORY_HOME — so they target the default
 * \`~/factory/data.db\` instead of the live daemon's DB. The seed
 * silently lands on the wrong DB, the live DB drifts, and missing-
 * prompts/missing-table failures appear at runtime (e.g. the v0.5.0
 * push_subscriptions regression). Returns null if the unit doesn't
 * exist or carries no FACTORY_HOME.
 */
async function factoryHomeFromUnit(): Promise<string | null> {
  const p = unitPath();
  if (!existsSync(p)) return null;
  try {
    const text = await readFile(p, "utf8");
    const m = text.match(/^Environment=FACTORY_HOME=(.+)$/m);
    if (!m) return null;
    const candidate = (m[1] ?? "").trim();
    return candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Verify that `checkout` is the root of a git working tree before we
 * lean on `git status`. Otherwise the operator gets a confusing
 * "fatal: not a git repository — re-run with --force" message, where
 * --force only bypasses dirty checks and won't help.
 */
async function isGitRepo(checkout: string): Promise<boolean> {
  if (!existsSync(checkout)) return false;
  const r = await run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: checkout });
  return r.exitCode === 0 && r.stdout.trim() === "true";
}

async function detectBun(): Promise<string> {
  return process.env.FACTORY_CLI_BUN || (await whichBin("bun")) || "bun";
}

export async function runUpgrade(args: UpgradeArgs): Promise<number> {
  if (args.help) {
    process.stdout.write(UPGRADE_HELP);
    return 0;
  }

  const cfg = await readConfig();
  const channel: Channel = args.channel ?? cfg.channel;

  // Resolve the checkout path with this priority: explicit --checkout flag,
  // CLI config (upgrade.checkout), then auto-discovery from the systemd
  // unit file's WorkingDirectory. Auto-discovery covers operators who
  // installed before the install command persisted upgrade.checkout (the
  // 12b2274 fix); the unit file has had the right value all along.
  let checkoutRaw = args.checkout ?? cfg.checkout;
  let checkoutSource: "flag" | "config" | "unit" = "flag";
  if (!checkoutRaw) {
    const fromUnit = await checkoutFromUnit();
    if (fromUnit) {
      checkoutRaw = fromUnit;
      checkoutSource = "unit";
      process.stdout.write(
        `factory: upgrade.checkout not configured — auto-discovered ${fromUnit} from factory.service\n` +
          "factory: persist this with `factory install --force` from that directory to silence this notice\n",
      );
    }
  } else if (args.checkout) {
    checkoutSource = "flag";
  } else {
    checkoutSource = "config";
  }

  if (!checkoutRaw) {
    const cfgPath = process.env.FACTORY_HOME
      ? path.join(process.env.FACTORY_HOME, "config.yaml")
      : "~/.factory/config.yaml";
    process.stderr.write(
      "factory: upgrade.checkout is not configured.\n" +
        "  upgrade.checkout must point at your dev clone of the Factory repo\n" +
        "  (the directory with .git), NOT the install dir.\n" +
        "\n" +
        "  fix:\n" +
        "    cd /path/to/your/factory/checkout\n" +
        "    factory install --force\n" +
        "\n" +
        `  this writes upgrade.checkout into ${cfgPath} so future\n` +
        "  upgrades work without --checkout.\n",
    );
    return 1;
  }
  const checkout = path.resolve(checkoutRaw);

  // Validate before any git invocation so the operator gets a directive
  // error instead of "fatal: not a git repository — re-run with --force"
  // (which is misleading; --force only bypasses the dirty check, not
  // missing .git).
  if (!(await isGitRepo(checkout))) {
    const where =
      checkoutSource === "flag"
        ? "the path passed to --checkout"
        : checkoutSource === "config"
          ? "upgrade.checkout in your CLI config"
          : "the auto-discovered path from factory.service";
    process.stderr.write(
      `factory: ${checkout} is not a git repository.\n` +
        `  ${where} must point at your dev clone of the Factory repo,\n` +
        "  not the install dir or runtime FACTORY_HOME.\n" +
        "\n" +
        "  fix:\n" +
        "    cd /path/to/your/factory/checkout    # the dir with .git\n" +
        "    factory install --force\n",
    );
    return 1;
  }

  const bunBin = await detectBun();

  // Resolve FACTORY_HOME from the systemd unit so subprocess calls
  // (migrate, seed) target the live daemon's DB. Without this, an
  // operator running `factory upgrade` from an interactive shell that
  // doesn't export FACTORY_HOME silently seeds `~/factory/data.db` —
  // not the daemon's DB. Falls back to whatever's already in the
  // process env (e.g. when the operator did export it explicitly).
  const factoryHomeUnit = await factoryHomeFromUnit();
  const subprocessEnv: Record<string, string | undefined> = factoryHomeUnit
    ? { FACTORY_HOME: factoryHomeUnit }
    : {};
  if (factoryHomeUnit && process.env.FACTORY_HOME !== factoryHomeUnit) {
    // Point THIS process's FACTORY_HOME at the daemon's home too, so the
    // upgrade bookkeeping (writeLastGood / appendUpgradeLog, which resolve
    // their state dir from process.env.FACTORY_HOME) lands in the live home's
    // state/ — not the default ~/.factory. Without this, an operator running
    // `factory upgrade` from an interactive shell that doesn't export
    // FACTORY_HOME silently records last-good.sha + upgrade-log under
    // ~/.factory while the daemon (and its data.db) live under the unit's
    // FACTORY_HOME, so the live home's state file goes stale and misleading
    // even though the code, migrations, and seed all upgraded correctly.
    process.env.FACTORY_HOME = factoryHomeUnit;
    process.stdout.write(
      `factory: using FACTORY_HOME=${factoryHomeUnit} for migrate + seed + state bookkeeping (resolved from factory.service)\n`,
    );
  }

  // 1. precheck — clean tree
  const cleanState = await checkClean(checkout);
  if (cleanState.dirty && !args.force) {
    process.stderr.write(`factory: ${cleanState.reason} — re-run with --force to override\n`);
    return 1;
  }
  const fromSha = await currentHead(checkout);
  const lockBefore = await lockfileSha(checkout);

  // 2. resolve channel → sha
  let target: ResolvedChannel;
  try {
    target = await resolveChannel(channel, {
      checkout,
      remote: cfg.remote,
      devBranch: cfg.devBranch,
    });
  } catch (err) {
    if (err instanceof ChannelResolveError) {
      process.stderr.write(`factory: resolve failed: ${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (target.sha === fromSha) {
    process.stdout.write(`factory: already on ${shortSha(fromSha)} (channel ${channel})\n`);
    return 0;
  }

  process.stdout.write(
    `factory: ${channel}  ${shortSha(fromSha)} → ${shortSha(target.sha)}  (${target.ref}${
      target.subject ? `: ${target.subject}` : ""
    })\n`,
  );

  if (args.dryRun) {
    process.stdout.write("factory: dry-run, no changes made\n");
    return 0;
  }

  // 3. checkout
  try {
    await checkoutSha(checkout, target.sha);
  } catch (err) {
    process.stderr.write(`factory: ${(err as Error).message}\n`);
    await appendUpgradeLog({
      ts: Date.now(),
      from: fromSha,
      to: target.sha,
      channel,
      ok: false,
      error: (err as Error).message,
    });
    return 1;
  }

  // 4. bun install if lockfile differs
  const lockAfter = await lockfileSha(checkout);
  if (lockBefore !== lockAfter) {
    process.stdout.write("factory: bun.lock changed — running bun install\n");
    const dep = await bunInstall(checkout, bunBin);
    if (!dep.ok) {
      process.stderr.write(`factory: bun install failed: ${dep.stderr.trim()}\n`);
      await appendUpgradeLog({
        ts: Date.now(),
        from: fromSha,
        to: target.sha,
        channel,
        ok: false,
        error: "bun install failed",
      });
      return 1;
    }
  }

  // 5. migrate
  process.stdout.write("factory: running db:migrate\n");
  const mig = await runMigrations(checkout, bunBin, subprocessEnv);
  if (!mig.ok) {
    process.stderr.write(`factory: db:migrate failed: ${mig.stderr.trim()}\n`);
    process.stderr.write(
      `factory: checkout is now at ${shortSha(target.sha)}; rollback with: git -C ${checkout} checkout ${shortSha(fromSha)} && factory restart\n`,
    );
    await appendUpgradeLog({
      ts: Date.now(),
      from: fromSha,
      to: target.sha,
      channel,
      ok: false,
      error: "db:migrate failed",
    });
    return 1;
  }

  // 5a. seed (idempotent — picks up new prompts/rubrics shipped by the release)
  process.stdout.write("factory: seeding prompts + rubrics\n");
  const seedRes = await runSeed(checkout, bunBin, subprocessEnv);
  if (!seedRes.ok) {
    process.stderr.write(`factory: seed failed: ${seedRes.stderr.trim()}\n`);
    await appendUpgradeLog({
      ts: Date.now(),
      from: fromSha,
      to: target.sha,
      channel,
      ok: false,
      error: "seed failed",
    });
    return 1;
  }

  // 5b. rebuild the CLI dist so a CLI bug-fix shipped in this release
  // actually reaches the operator's `~/.local/bin/factory` symlink. The
  // process currently running this upgrade IS the old CLI; replacing
  // dist/factory in place is safe (Linux keeps the running process's
  // inode open) and the next `factory <anything>` picks up the new code.
  // Without this step, CLI fixes ship in `src/` but stay dormant in
  // `dist/factory` until someone manually `bun run cli:install`s — the
  // exact trap that masked the FACTORY_HOME-for-seed fix in v0.6.0.
  process.stdout.write("factory: rebuilding cli\n");
  const cli = await buildCli(checkout, bunBin);
  if (!cli.ok) {
    process.stderr.write(`factory: cli build failed: ${cli.stderr.trim()}\n`);
    await appendUpgradeLog({
      ts: Date.now(),
      from: fromSha,
      to: target.sha,
      channel,
      ok: false,
      error: "cli build failed",
    });
    return 1;
  }

  // 5c. build PWA dist before the new daemon starts
  process.stdout.write("factory: building pwa\n");
  const pwa = await buildPwa(checkout, bunBin);
  if (!pwa.ok) {
    process.stderr.write(`factory: pwa build failed: ${pwa.stderr.trim()}\n`);
    await appendUpgradeLog({
      ts: Date.now(),
      from: fromSha,
      to: target.sha,
      channel,
      ok: false,
      error: "pwa build failed",
    });
    return 1;
  }

  // 6. restart + probe
  if (args.skipRestart) {
    process.stdout.write("factory: --skip-restart given; not restarting unit\n");
  } else {
    const restart = await systemctl("restart");
    if (restart.exitCode !== 0) {
      process.stderr.write(`factory: systemctl restart failed: ${restart.stderr.trim()}\n`);
      await appendUpgradeLog({
        ts: Date.now(),
        from: fromSha,
        to: target.sha,
        channel,
        ok: false,
        error: "restart failed",
      });
      return 1;
    }
    process.stdout.write("factory: restarted, probing /health…\n");
    const expectedVersion = target.ref.startsWith("v") ? target.ref : shortSha(target.sha);
    const probe = await probeUntilVersion(expectedVersion);
    if (!probe.ok) {
      process.stderr.write(`factory: /health probe failed: ${probe.reason}\n`);
      process.stderr.write(
        `factory: rollback with: git -C ${checkout} checkout ${shortSha(fromSha)} && factory restart\n`,
      );
      await appendUpgradeLog({
        ts: Date.now(),
        from: fromSha,
        to: target.sha,
        channel,
        ok: false,
        error: probe.reason ?? "probe timed out",
      });
      return 1;
    }
    process.stdout.write(`factory: /health ok  version=${probe.version}\n`);
  }

  // 7. success — record
  await writeLastGood(target.sha);
  await appendUpgradeLog({
    ts: Date.now(),
    from: fromSha,
    to: target.sha,
    channel,
    ok: true,
  });
  process.stdout.write(`factory: upgraded to ${shortSha(target.sha)} (${target.ref})\n`);

  // Surface the prior sha in case the operator needs to roll back.
  const lg = await readLastGood();
  if (lg && lg !== target.sha) {
    process.stdout.write(`factory: prior last-good was ${shortSha(lg)}\n`);
  }
  return 0;
}
