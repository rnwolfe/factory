import { ChannelResolveError, resolveChannel, shortSha } from "../lib/channel.ts";
import { type Channel, readConfig, writeConfig } from "../lib/config.ts";
import { readLastGood } from "../lib/state.ts";

function isChannel(v: string): v is Channel {
  return v === "stable" || v === "nightly" || v === "dev";
}

export async function runChannel(argv: string[]): Promise<number> {
  const sub = argv[0];

  // `factory channel` (no args) — show current.
  if (!sub) {
    const cfg = await readConfig();
    const lg = await readLastGood();
    process.stdout.write(`channel:    ${cfg.channel}\n`);
    if (cfg.channel === "dev") process.stdout.write(`devBranch:  ${cfg.devBranch}\n`);
    process.stdout.write(`remote:     ${cfg.remote}\n`);
    if (cfg.checkout) process.stdout.write(`checkout:   ${cfg.checkout}\n`);
    process.stdout.write(`last-good:  ${lg ? shortSha(lg) : "(none)"}\n`);
    return 0;
  }

  // `factory channel resolve` — dry-run lookup.
  if (sub === "resolve") {
    return await resolveSubcommand();
  }

  // `factory channel <stable|nightly|dev> [--dev-branch=<name>]`
  if (isChannel(sub)) {
    let devBranch: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a?.startsWith("--dev-branch=")) devBranch = a.slice("--dev-branch=".length);
      else if (a === "--dev-branch") devBranch = argv[++i];
    }
    await writeConfig({ channel: sub, ...(devBranch ? { devBranch } : {}) });
    process.stdout.write(`factory: channel set to ${sub}\n`);
    return 0;
  }

  process.stderr.write(`factory: unknown channel subcommand '${sub}'\n`);
  process.stderr.write("usage: factory channel [stable|nightly|dev|resolve]\n");
  return 1;
}

async function resolveSubcommand(): Promise<number> {
  const cfg = await readConfig();
  const checkout = cfg.checkout || process.cwd();
  try {
    const r = await resolveChannel(cfg.channel, {
      checkout,
      remote: cfg.remote,
      devBranch: cfg.devBranch,
    });
    process.stdout.write(
      `${r.channel}  ${r.ref}  ${shortSha(r.sha)}  ${r.subject ?? "(no subject)"}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ChannelResolveError) {
      process.stderr.write(`factory: ${err.code}: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`factory: ${(err as Error).message}\n`);
    return 1;
  }
}
