import path from "node:path";

import {
  ChannelResolveError,
  type ResolvedChannel,
  resolveChannel,
  shortSha,
} from "../lib/channel.ts";
import { type Channel, readConfig } from "../lib/config.ts";
import { whichBin } from "../lib/exec.ts";
import { appendUpgradeLog, readLastGood, writeLastGood } from "../lib/state.ts";
import { systemctl } from "../lib/systemctl.ts";
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
}

export function parseUpgradeArgs(argv: string[]): UpgradeArgs {
  let channel: Channel | undefined;
  let checkout: string | undefined;
  let dryRun = false;
  let force = false;
  let skipRestart = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--skip-restart") skipRestart = true;
    else if (a === "--channel") channel = argv[++i] as Channel;
    else if (a?.startsWith("--channel=")) channel = a.slice("--channel=".length) as Channel;
    else if (a === "--checkout") checkout = argv[++i];
    else if (a?.startsWith("--checkout=")) checkout = a.slice("--checkout=".length);
  }
  return { channel, checkout, dryRun, force, skipRestart };
}

async function detectBun(): Promise<string> {
  return process.env.FACTORY_CLI_BUN || (await whichBin("bun")) || "bun";
}

export async function runUpgrade(args: UpgradeArgs): Promise<number> {
  const cfg = await readConfig();
  const channel: Channel = args.channel ?? cfg.channel;
  // Refuse the silent fall-through to cwd: running `factory upgrade` from
  // $HOME (or any non-checkout dir) used to "succeed" into "fatal: not a
  // git repository" once the first git call ran. That's a confusing
  // surface for an unconfigured install. Tell the operator exactly what
  // to do.
  const checkoutRaw = args.checkout ?? cfg.checkout;
  if (!checkoutRaw) {
    process.stderr.write(
      "factory: upgrade.checkout is not configured.\n" +
        "  Either pass --checkout=/path/to/factory, or set upgrade.checkout in\n" +
        `  ${process.env.FACTORY_HOME ? path.join(process.env.FACTORY_HOME, "config.yaml") : "~/.factory/config.yaml"}.\n` +
        "  Re-running `factory install` from inside the dev checkout will persist it.\n",
    );
    return 1;
  }
  const checkout = path.resolve(checkoutRaw);
  const bunBin = await detectBun();

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
  const mig = await runMigrations(checkout, bunBin);
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
  const seedRes = await runSeed(checkout, bunBin);
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

  // 5b. build PWA dist before the new daemon starts
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
