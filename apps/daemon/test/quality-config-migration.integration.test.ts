import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type Db, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import {
  DEFAULT_MAKEFILE,
  DEFAULT_QUALITY_YAML,
  LEGACY_QUALITY_YAML_DEFAULTS,
  migrateQualityConfigs,
} from "../src/projects/quality-config.ts";

const GIT_AUTHOR = { name: "Factory Test", email: "test@factory" };
const LEGACY_V1 = LEGACY_QUALITY_YAML_DEFAULTS[0] ?? "";

async function git(cwd: string, args: string[]): Promise<void> {
  await bunSpawn({ cmd: ["git", ...args], cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

interface MakeProjectOpts {
  quality: string;
  /** Seed a Makefile (a "real" one the migration must not clobber). */
  makefile?: string;
  /** Leave an uncommitted file so the working tree is dirty. */
  dirty?: boolean;
}

async function makeProject(root: string, db: Db, opts: MakeProjectOpts): Promise<string> {
  const slug = `proj-${createId().slice(0, 8)}`;
  const workdir = path.join(root, slug);
  mkdirSync(path.join(workdir, ".factory"), { recursive: true });
  writeFileSync(path.join(workdir, "README.md"), `# ${slug}\n`);
  writeFileSync(path.join(workdir, ".factory", "quality.yaml"), opts.quality);
  if (opts.makefile !== undefined) {
    writeFileSync(path.join(workdir, "Makefile"), opts.makefile);
  }
  await git(workdir, ["init", "-q", "-b", "main"]);
  await git(workdir, ["config", "user.email", GIT_AUTHOR.email]);
  await git(workdir, ["config", "user.name", GIT_AUTHOR.name]);
  await git(workdir, ["add", "-A"]);
  await git(workdir, ["commit", "-q", "-m", "init"]);
  if (opts.dirty) {
    writeFileSync(path.join(workdir, "scratch.txt"), "uncommitted\n");
  }
  await db.insert(schema.projects).values({
    id: createId(),
    slug,
    name: slug,
    ceremony: "tinker",
    tag: "active",
    workdirPath: workdir,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  return workdir;
}

function freshDb(root: string): Db {
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return createDb(dbPath);
}

describe("migrateQualityConfigs", () => {
  test("rewrites a legacy-default quality.yaml and seeds a Makefile", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-qmig-"));
    try {
      const db = freshDb(root);
      const workdir = await makeProject(root, db, { quality: LEGACY_V1 });

      expect(await migrateQualityConfigs({ db, gitAuthor: GIT_AUTHOR })).toBe(1);
      expect(readFileSync(path.join(workdir, ".factory", "quality.yaml"), "utf8")).toBe(
        DEFAULT_QUALITY_YAML,
      );
      expect(readFileSync(path.join(workdir, "Makefile"), "utf8")).toBe(DEFAULT_MAKEFILE);

      // Idempotent: the rewritten config carries the marker, so a second pass
      // is a no-op.
      expect(await migrateQualityConfigs({ db, gitAuthor: GIT_AUTHOR })).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("leaves a customized quality.yaml untouched", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-qmig-"));
    try {
      const db = freshDb(root);
      const custom = "checks:\n  - name: typecheck\n    command: cargo check\n";
      const workdir = await makeProject(root, db, { quality: custom });

      expect(await migrateQualityConfigs({ db, gitAuthor: GIT_AUTHOR })).toBe(0);
      expect(readFileSync(path.join(workdir, ".factory", "quality.yaml"), "utf8")).toBe(custom);
      expect(existsSync(path.join(workdir, "Makefile"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("migrates quality.yaml but never clobbers an existing Makefile", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-qmig-"));
    try {
      const db = freshDb(root);
      const realMakefile = "typecheck:\n\tpnpm tsc --noEmit\n";
      const workdir = await makeProject(root, db, { quality: LEGACY_V1, makefile: realMakefile });

      expect(await migrateQualityConfigs({ db, gitAuthor: GIT_AUTHOR })).toBe(1);
      expect(readFileSync(path.join(workdir, ".factory", "quality.yaml"), "utf8")).toBe(
        DEFAULT_QUALITY_YAML,
      );
      // The project's real Makefile is the agent's domain — never overwritten.
      expect(readFileSync(path.join(workdir, "Makefile"), "utf8")).toBe(realMakefile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("skips a project whose working tree is dirty", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-qmig-"));
    try {
      const db = freshDb(root);
      const workdir = await makeProject(root, db, { quality: LEGACY_V1, dirty: true });

      expect(await migrateQualityConfigs({ db, gitAuthor: GIT_AUTHOR })).toBe(0);
      expect(readFileSync(path.join(workdir, ".factory", "quality.yaml"), "utf8")).toBe(LEGACY_V1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
