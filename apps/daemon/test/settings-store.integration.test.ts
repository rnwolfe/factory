import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations } from "@factory/db";
import type { FactoryConfig } from "../src/config.ts";
import {
  applySettingsFromDb,
  clearSetting,
  parseReplyAllowlist,
  setSetting,
  snapshotSettings,
} from "../src/settings/store.ts";

function setup(): {
  db: ReturnType<typeof createDb>;
  config: FactoryConfig;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "factory-settings-test-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot: path.join(root, "worktrees"),
    dbPath,
    maxConcurrentRuns: 4,
    defaultRunBudgetSeconds: 7200,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "yaml-name", email: "yaml@example.com" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    githubReplyAllowlist: [],
    publicBaseUrl: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    db,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("settings store", () => {
  test("applySettingsFromDb is a no-op when no rows exist", () => {
    const h = setup();
    try {
      applySettingsFromDb(h.db, h.config);
      expect(h.config.gitAuthor.name).toBe("yaml-name");
      expect(h.config.maxConcurrentRuns).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  test("setSetting overrides yaml defaults and reflects in config + snapshot", () => {
    const h = setup();
    try {
      setSetting(h.db, h.config, "git-author-name", "operator-set");
      expect(h.config.gitAuthor.name).toBe("operator-set");
      // email untouched.
      expect(h.config.gitAuthor.email).toBe("yaml@example.com");

      setSetting(h.db, h.config, "max-concurrent-runs", "8");
      expect(h.config.maxConcurrentRuns).toBe(8);

      const snap = snapshotSettings(h.db, h.config);
      expect(snap.gitAuthor.name).toBe("operator-set");
      expect(snap.overridden["git-author-name"]).toBe(true);
      expect(snap.overridden["git-author-email"]).toBe(false);
      expect(snap.overridden["max-concurrent-runs"]).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("github-token round trips and empty string clears the override", () => {
    const h = setup();
    try {
      setSetting(h.db, h.config, "github-token", "ghp_test123");
      expect(h.config.githubToken).toBe("ghp_test123");
      setSetting(h.db, h.config, "github-token", "");
      expect(h.config.githubToken).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("clearSetting removes the row and falls back to yaml", () => {
    const h = setup();
    try {
      setSetting(h.db, h.config, "git-author-name", "operator");
      expect(h.config.gitAuthor.name).toBe("operator");
      clearSetting(h.db, h.config, "git-author-name");
      expect(h.config.gitAuthor.name).toBe("yaml-name");
      const snap = snapshotSettings(h.db, h.config);
      expect(snap.overridden["git-author-name"]).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("github-app-reply-allowlist parses into a deduped, lowercased array", () => {
    const h = setup();
    try {
      setSetting(h.db, h.config, "github-app-reply-allowlist", "Alice, @Bob\nalice  carol");
      expect(h.config.githubReplyAllowlist).toEqual(["alice", "bob", "carol"]);
      const snap = snapshotSettings(h.db, h.config);
      expect(snap.githubReplyAllowlist).toEqual(["alice", "bob", "carol"]);
      expect(snap.overridden["github-app-reply-allowlist"]).toBe(true);

      clearSetting(h.db, h.config, "github-app-reply-allowlist");
      expect(h.config.githubReplyAllowlist).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("public-base-url normalizes trailing slashes and clears on empty", () => {
    const h = setup();
    try {
      setSetting(h.db, h.config, "public-base-url", "https://heimdall.example.com/");
      expect(h.config.publicBaseUrl).toBe("https://heimdall.example.com");
      const snap = snapshotSettings(h.db, h.config);
      expect(snap.publicBaseUrl).toBe("https://heimdall.example.com");
      expect(snap.overridden["public-base-url"]).toBe(true);

      setSetting(h.db, h.config, "public-base-url", "");
      expect(h.config.publicBaseUrl).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("parseReplyAllowlist tolerates @, commas, and whitespace", () => {
    expect(parseReplyAllowlist("")).toEqual([]);
    expect(parseReplyAllowlist("  @octocat ,, hubot  ")).toEqual(["octocat", "hubot"]);
    expect(parseReplyAllowlist("Foo\nfoo")).toEqual(["foo"]);
  });

  test("invalid number values are ignored on apply (defensive parse)", () => {
    const h = setup();
    try {
      // Write a malformed value directly via setSetting (bypassing router validation).
      setSetting(h.db, h.config, "max-concurrent-runs", "not-a-number");
      // The applier should fall back to the previous yaml value.
      expect(h.config.maxConcurrentRuns).toBe(4);
    } finally {
      h.cleanup();
    }
  });
});
