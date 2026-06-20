import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runUpgrade } from "../src/commands/upgrade.ts";
import { writeConfig } from "../src/lib/config.ts";
import { run } from "../src/lib/exec.ts";

let tmpRoot: string;
let factoryHome: string;
let configPath: string;
let upstream: string;
let checkout: string;
let argLog: string;

async function git(args: string[], cwd: string): Promise<void> {
  const r = await run(["git", ...args], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function commit(cwd: string, file: string, body: string, msg: string): Promise<void> {
  writeFileSync(path.join(cwd, file), body, "utf8");
  await git(["add", file], cwd);
  await git(["commit", "-m", msg], cwd);
}

function writeFakeBin(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "factory-upgrade-"));
  factoryHome = path.join(tmpRoot, "home");
  configPath = path.join(tmpRoot, "config.yaml");
  argLog = path.join(tmpRoot, "args.log");

  // Upstream with two tags; latest is v2.0.0.
  upstream = path.join(tmpRoot, "upstream");
  await git(["init", "-q", "-b", "main", upstream], tmpRoot);
  await commit(upstream, "package.json", '{"name":"factory","version":"1.0.0"}', "init");
  // db:migrate is invoked via `bun run db:migrate`. Keep package.json scripts minimal.
  await commit(
    upstream,
    "package.json",
    '{"name":"factory","version":"1.0.0","scripts":{"db:migrate":"echo migrated"}}',
    "scripts: db:migrate",
  );
  await git(["tag", "v1.0.0"], upstream);
  await commit(
    upstream,
    "package.json",
    '{"name":"factory","version":"2.0.0","scripts":{"db:migrate":"echo migrated"}}',
    "feat: v2",
  );
  await git(["tag", "v2.0.0"], upstream);

  checkout = path.join(tmpRoot, "checkout");
  await git(["clone", "-q", upstream, checkout], tmpRoot);
  // Reset to v1.0.0 so we can upgrade to v2.0.0.
  await git(["checkout", "-q", "--detach", "v1.0.0"], checkout);

  await writeConfig(
    { channel: "stable", remote: "origin", checkout, devBranch: "dev" },
    configPath,
  );

  // Test seams.
  process.env.FACTORY_HOME = factoryHome;
  process.env.FACTORY_CLI_BUN = writeFakeBin(
    "bun",
    `printf 'bun %s\\n' "$*" >> "${argLog}"; exit 0`,
  );
  process.env.FACTORY_CLI_SYSTEMCTL = writeFakeBin(
    "systemctl",
    `printf 'systemctl %s\\n' "$*" >> "${argLog}"; exit 0`,
  );
  // The real config path is honored at runtime; redirect via a guarded re-import.
  // Here we just point readConfig/writeConfig at our fixture by setting the
  // module-level default override via env. Easiest path: make the orchestrator
  // accept --config? We use the existing in-test approach: copy our config to
  // the operator default temporarily by setting HOME to tmpRoot.
  process.env.HOME = tmpRoot;
  // Isolate the systemd unit lookup. unitPath() resolves via
  // os.homedir() (which ignores process.env.HOME on POSIX) but honors
  // XDG_CONFIG_HOME — so without this, the test reads the operator's REAL
  // ~/.config/systemd/user/factory.service, and any code that resolves
  // FACTORY_HOME from the unit (e.g. the state-bookkeeping fix) would
  // redirect this test's writes onto the live home. Point it at the temp
  // tree so factoryHomeFromUnit() finds nothing.
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, ".config");
  // Move config into the default location ($HOME/.factory/config.yaml).
  const defaultDir = path.join(tmpRoot, ".factory");
  await Bun.$`mkdir -p ${defaultDir}`;
  await Bun.$`cp ${configPath} ${path.join(defaultDir, "config.yaml")}`;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.FACTORY_HOME;
  delete process.env.FACTORY_CLI_BUN;
  delete process.env.FACTORY_CLI_SYSTEMCTL;
  delete process.env.HOME;
  delete process.env.XDG_CONFIG_HOME;
});

describe("factory upgrade", () => {
  test("dry-run prints target without changing HEAD", async () => {
    const before = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: true,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);
    const after = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    expect(after).toBe(before);
  });

  test("no-op when target equals current head", async () => {
    // Move to v2.0.0 (the highest tag) so resolve says we're already there.
    await git(["checkout", "-q", "--detach", "v2.0.0"], checkout);
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);
    // No upgrade-log entry expected.
    const logPath = path.join(factoryHome, "state", "upgrade-log.jsonl");
    expect(existsSync(logPath)).toBe(false);
  });

  test("refuses dirty checkout without --force", async () => {
    writeFileSync(path.join(checkout, "package.json"), "garbage", "utf8");
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(1);
  });

  test("--force proceeds on a dirty checkout", async () => {
    writeFileSync(path.join(checkout, "untracked.txt"), "x", "utf8");
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: true,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const v2 = (await run(["git", "rev-parse", "v2.0.0"], { cwd: checkout })).stdout.trim();
    expect(head).toBe(v2);
  });

  test("clean upgrade: checkout + migrate + state recorded", async () => {
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const v2 = (await run(["git", "rev-parse", "v2.0.0"], { cwd: checkout })).stdout.trim();
    expect(head).toBe(v2);

    // last-good.sha written
    const lg = readFileSync(path.join(factoryHome, "state", "last-good.sha"), "utf8").trim();
    expect(lg).toBe(v2);

    // upgrade-log row written, ok=true
    const log = readFileSync(path.join(factoryHome, "state", "upgrade-log.jsonl"), "utf8");
    const entries = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(true);
    expect(entries[0].to).toBe(v2);
    expect(entries[0].channel).toBe("stable");

    // db:migrate invoked
    const args = readFileSync(argLog, "utf8");
    expect(args).toContain("bun run db:migrate");
  });

  test("when on main, upgrade fast-forwards main instead of detaching", async () => {
    // Operator's checkout starts on the main branch (the common setup);
    // a Factory project whose workdir IS the checkout depends on HEAD
    // staying attached so `mergeIntoMain` can land run branches.
    await git(["checkout", "-q", "main"], checkout);
    // Reset main to v1.0.0 so the upgrade has somewhere to advance to.
    await git(["reset", "-q", "--hard", "v1.0.0"], checkout);

    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);

    // HEAD is on main (not detached) and main now points at v2.0.0.
    const sym = (
      await run(["git", "symbolic-ref", "--short", "HEAD"], { cwd: checkout })
    ).stdout.trim();
    expect(sym).toBe("main");
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const v2 = (await run(["git", "rev-parse", "v2.0.0"], { cwd: checkout })).stdout.trim();
    expect(head).toBe(v2);
  });

  test("non-FF branch falls back to detached, preserving local commits", async () => {
    // Operator was on main with a local commit that diverges from origin —
    // the upgrade can't fast-forward, so it should detach onto the target
    // sha (so the tree matches the release) while leaving the local
    // branch ref where it was (so no work is lost).
    await git(["checkout", "-q", "main"], checkout);
    await git(["reset", "-q", "--hard", "v1.0.0"], checkout);
    await commit(checkout, "local-only.txt", "local work", "wip: local-only commit");
    const localMainBefore = (
      await run(["git", "rev-parse", "main"], { cwd: checkout })
    ).stdout.trim();

    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(0);

    // HEAD detached at v2.0.0; main ref untouched (operator's commit safe).
    const sym = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: checkout });
    expect(sym.exitCode).not.toBe(0); // detached → symbolic-ref fails
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const v2 = (await run(["git", "rev-parse", "v2.0.0"], { cwd: checkout })).stdout.trim();
    expect(head).toBe(v2);
    const localMainAfter = (
      await run(["git", "rev-parse", "main"], { cwd: checkout })
    ).stdout.trim();
    expect(localMainAfter).toBe(localMainBefore);
  });

  test("migrate failure leaves checkout on new sha + records ok=false", async () => {
    // Replace the bun stub with one that fails on db:migrate.
    process.env.FACTORY_CLI_BUN = writeFakeBin(
      "bun-fail",
      `case "$*" in *db:migrate*) >&2 echo migration broken; exit 5;; esac; exit 0`,
    );
    const code = await runUpgrade({
      channel: undefined,
      checkout,
      dryRun: false,
      force: false,
      skipRestart: true,
      help: false,
    });
    expect(code).toBe(1);
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const v2 = (await run(["git", "rev-parse", "v2.0.0"], { cwd: checkout })).stdout.trim();
    expect(head).toBe(v2);
    const log = readFileSync(path.join(factoryHome, "state", "upgrade-log.jsonl"), "utf8");
    const entry = JSON.parse(log.trim().split("\n").pop() ?? "{}");
    expect(entry.ok).toBe(false);
    expect(entry.error).toContain("db:migrate");
  });
});
