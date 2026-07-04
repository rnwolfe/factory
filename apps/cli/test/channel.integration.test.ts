import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ChannelResolveError, resolveChannel } from "../src/lib/channel.ts";
import { defaults, readConfig, writeConfig } from "../src/lib/config.ts";
import { run } from "../src/lib/exec.ts";

let tmpRoot: string;
let configPath: string;
let upstream: string;
let checkout: string;

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

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "factory-channel-"));
  configPath = path.join(tmpRoot, "config.yaml");

  // Build a bare-style upstream repo with main + a v1.0.0 tag + a dev branch.
  upstream = path.join(tmpRoot, "upstream");
  await git(["init", "-q", "-b", "main", upstream], tmpRoot);
  await commit(upstream, "README", "v0\n", "initial");
  await commit(upstream, "README", "v1\n", "feat: stuff");
  await git(["tag", "v1.0.0"], upstream);
  await commit(upstream, "README", "v1.1\n", "feat: more");
  await git(["tag", "v1.1.0"], upstream);
  await commit(upstream, "README", "nightly\n", "chore: nightly tip");
  await git(["checkout", "-b", "dev"], upstream);
  await commit(upstream, "README", "dev tip\n", "feat: dev only");
  await git(["checkout", "main"], upstream);

  // Local checkout that points at the upstream as `origin`.
  checkout = path.join(tmpRoot, "checkout");
  await git(["clone", "-q", upstream, checkout], tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("channel config", () => {
  test("defaults when file is absent", async () => {
    const cfg = await readConfig(configPath);
    expect(cfg).toEqual(defaults());
  });

  test("write + readConfig round-trips", async () => {
    await writeConfig({ channel: "nightly" }, configPath);
    let cfg = await readConfig(configPath);
    expect(cfg.channel).toBe("nightly");

    await writeConfig({ channel: "dev", devBranch: "release-2" }, configPath);
    cfg = await readConfig(configPath);
    expect(cfg.channel).toBe("dev");
    expect(cfg.devBranch).toBe("release-2");
  });

  test("preserves a comment in an existing config.yaml", async () => {
    const initial = "# operator-edited\nupgrade:\n  channel: stable\n  remote: origin\n";
    writeFileSync(configPath, initial, "utf8");
    await writeConfig({ channel: "nightly" }, configPath);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("# operator-edited");
    expect(text).toContain("channel: nightly");
  });
});

describe("resolveChannel", () => {
  test("stable picks the highest semver tag", async () => {
    const r = await resolveChannel("stable", {
      checkout,
      remote: "origin",
      devBranch: "dev",
    });
    expect(r.channel).toBe("stable");
    expect(r.ref).toBe("v1.1.0");
    expect(r.sha).toMatch(/^[0-9a-f]+$/);
  });

  test("nightly resolves to origin/main tip", async () => {
    const r = await resolveChannel("nightly", {
      checkout,
      remote: "origin",
      devBranch: "dev",
    });
    expect(r.channel).toBe("nightly");
    expect(r.ref).toBe("origin/main");
    expect(r.subject).toBe("chore: nightly tip");
  });

  test("dev resolves to the configured dev branch", async () => {
    const r = await resolveChannel("dev", {
      checkout,
      remote: "origin",
      devBranch: "dev",
    });
    expect(r.subject).toBe("feat: dev only");
  });

  test("dev with non-existent branch surfaces branch_not_found", async () => {
    let caught: ChannelResolveError | null = null;
    try {
      await resolveChannel("dev", {
        checkout,
        remote: "origin",
        devBranch: "no-such-branch",
      });
    } catch (err) {
      caught = err as ChannelResolveError;
    }
    expect(caught?.code).toBe("branch_not_found");
  });

  test("stable peels an ANNOTATED tag to its commit and fetches it into the checkout", async () => {
    // The dwell-first-deploy regression: release flows create annotated tags,
    // whose ls-remote sha is the TAG OBJECT — and a checkout cloned BEFORE the
    // tag existed has neither the ref nor the objects. Both bit at once.
    await commit(upstream, "README", "v2\n", "feat: the two release");
    await git(["tag", "-a", "v2.0.0", "-m", "release v2.0.0"], upstream);

    const r = await resolveChannel("stable", {
      checkout, // cloned in beforeEach, BEFORE v2.0.0 existed
      remote: "origin",
      devBranch: "dev",
    });
    expect(r.ref).toBe("v2.0.0");
    // The sha must be the PEELED COMMIT, never the tag object…
    const type = await run(["git", "cat-file", "-t", r.sha], { cwd: checkout });
    expect(type.stdout.trim()).toBe("commit");
    expect(r.subject).toBe("feat: the two release");
    // …and the object must now exist locally, so the upgrade checkout works.
    const co = await run(["git", "checkout", "--quiet", "--detach", r.sha], { cwd: checkout });
    expect(co.exitCode).toBe(0);
  });

  test("stable with no tags surfaces no_tags", async () => {
    // Create a checkout pointing at a tagless upstream.
    const blank = path.join(tmpRoot, "blank-upstream");
    await git(["init", "-q", "-b", "main", blank], tmpRoot);
    await commit(blank, "F", "x", "init");
    const blankCheckout = path.join(tmpRoot, "blank-checkout");
    await git(["clone", "-q", blank, blankCheckout], tmpRoot);

    let caught: ChannelResolveError | null = null;
    try {
      await resolveChannel("stable", {
        checkout: blankCheckout,
        remote: "origin",
        devBranch: "dev",
      });
    } catch (err) {
      caught = err as ChannelResolveError;
    }
    expect(caught?.code).toBe("no_tags");
  });
});
