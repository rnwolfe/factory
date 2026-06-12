import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import type { FactoryConfig } from "../src/config.ts";
import { ImportError, importFromPath, importFromUrl } from "../src/projects/import.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-import-test-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  const projectsRoot = path.join(root, "projects");
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(projectsRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
}

async function makeBareRepo(parent: string, name: string): Promise<string> {
  // Build a real local git repo with one commit. URL-mode clones use a
  // file:// URL pointing at this; path-mode tests adopt it directly.
  const repo = path.join(parent, name);
  mkdirSync(repo, { recursive: true });
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "t@t"], repo);
  await git(["config", "user.name", "t"], repo);
  writeFileSync(path.join(repo, "README.md"), "# hi\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "initial"], repo);
  return repo;
}

describe("projects.import", () => {
  test("importFromPath registers a real repo without copying it", async () => {
    const h = setupHarness();
    try {
      // Make a repo somewhere under the harness root (which is /tmp/...);
      // outside-$HOME guard would normally reject /tmp, so opt-in.
      process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME = "1";
      const repo = await makeBareRepo(h.root, "external-repo");
      const res = await importFromPath(h.config, h.db, {
        workdirPath: repo,
        role: "owner",
        ceremony: "tinker",
      });
      expect(res.workdirPath).toBe(repo);
      expect(res.slug).toBe("external-repo");
      expect(existsSync(path.join(repo, ".factory", "meta.yaml"))).toBe(true);
      expect(existsSync(path.join(repo, "README.md"))).toBe(true);
    } finally {
      delete process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME;
      h.cleanup();
    }
  });

  test("importFromPath rejects a non-git directory", async () => {
    const h = setupHarness();
    try {
      process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME = "1";
      const dir = path.join(h.root, "not-a-repo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "x.txt"), "hi");
      try {
        await importFromPath(h.config, h.db, {
          workdirPath: dir,
          role: "owner",
          ceremony: "tinker",
        });
        throw new Error("expected ImportError");
      } catch (err) {
        expect(err).toBeInstanceOf(ImportError);
        expect((err as ImportError).code).toBe("not_a_repo");
      }
    } finally {
      delete process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME;
      h.cleanup();
    }
  });

  test("importFromPath refuses to register the same path twice", async () => {
    const h = setupHarness();
    try {
      process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME = "1";
      const repo = await makeBareRepo(h.root, "twice");
      await importFromPath(h.config, h.db, {
        workdirPath: repo,
        role: "owner",
        ceremony: "tinker",
      });
      try {
        await importFromPath(h.config, h.db, {
          workdirPath: repo,
          role: "owner",
          ceremony: "tinker",
        });
        throw new Error("expected ImportError");
      } catch (err) {
        expect(err).toBeInstanceOf(ImportError);
        expect((err as ImportError).code).toBe("path_already_imported");
      }
    } finally {
      delete process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME;
      h.cleanup();
    }
  });

  test("importFromUrl rejects file:// urls (validation runs before clone)", async () => {
    const h = setupHarness();
    try {
      try {
        await importFromUrl(h.config, h.db, {
          url: "file:///tmp/whatever",
          role: "owner",
          ceremony: "tinker",
        });
        throw new Error("expected ImportError");
      } catch (err) {
        expect(err).toBeInstanceOf(ImportError);
        expect((err as ImportError).code).toBe("bad_url");
      }
    } finally {
      h.cleanup();
    }
  });

  test("importFromUrl rejects http:// urls", async () => {
    const h = setupHarness();
    try {
      try {
        await importFromUrl(h.config, h.db, {
          url: "http://example.com/repo.git",
          role: "owner",
          ceremony: "tinker",
        });
        throw new Error("expected ImportError");
      } catch (err) {
        expect(err).toBeInstanceOf(ImportError);
        expect((err as ImportError).code).toBe("bad_url");
      }
    } finally {
      h.cleanup();
    }
  });
});
