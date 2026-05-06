import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import YAML from "yaml";
import type { FactoryConfig } from "../config.ts";

/**
 * v0.4 cut 6 — bring an existing repo into Factory without going through
 * triage. Two modes: clone-from-URL (Factory clones into
 * <projectsRoot>/<slug>) and adopt-local-path (Factory points at an
 * existing checkout). Either way we write the .factory/ skeleton and
 * insert a `projects` row; the deepening flow can run afterward.
 *
 * Skeleton writes never clobber existing files. The repo's own README,
 * .gitignore, etc. are left in place.
 */

export type ImportCeremony = "tinker" | "personal" | "shared" | "production";
export type ImportRole = "owner" | "contributor";

export interface ImportFromUrlInput {
  url: string;
  name?: string;
  slug?: string;
  ceremony: ImportCeremony;
  role: ImportRole;
}

export interface ImportFromPathInput {
  workdirPath: string;
  name?: string;
  slug?: string;
  ceremony: ImportCeremony;
  role: ImportRole;
}

export interface ImportResult {
  projectId: string;
  slug: string;
  workdirPath: string;
}

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function deriveSlugFromUrl(url: string): string {
  // last path segment, .git stripped
  const trimmed = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).filter(Boolean).pop() ?? "imported";
  return slugify(last) || "imported";
}

function deriveSlugFromPath(p: string): string {
  return slugify(path.basename(p)) || "imported";
}

async function pickUniqueSlug(db: Db, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const all = await db.select({ slug: schema.projects.slug }).from(schema.projects).all();
    const taken = new Set(all.map((r) => r.slug));
    if (!taken.has(candidate)) return candidate;
    suffix++;
    candidate = `${base}-${suffix}`;
    if (suffix > 999) throw new Error("could not allocate unique slug");
  }
}

export class ImportError extends Error {
  readonly code:
    | "bad_url"
    | "bad_path"
    | "not_a_repo"
    | "path_outside_home"
    | "path_already_imported"
    | "clone_failed"
    | "clone_timeout"
    | "no_commits"
    | "slug_taken";
  constructor(code: ImportError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ImportError";
  }
}

function validateUrl(url: string): void {
  // Allow https:// and git@host:org/repo. Reject file://, http://, ssh:// (we
  // don't have a way to plumb credentials yet), and anything else.
  if (url.startsWith("https://")) return;
  if (/^git@[^:]+:[^/]+\/.+$/.test(url)) return;
  throw new ImportError(
    "bad_url",
    `unsupported URL: only https:// and git@host:org/repo are accepted (got ${url.slice(0, 80)})`,
  );
}

function validatePath(p: string): void {
  if (!path.isAbsolute(p)) {
    throw new ImportError("bad_path", `path must be absolute (got ${p})`);
  }
  // Containment guard: refuse paths outside $HOME unless an explicit allow
  // env var is set. Prevents an accidental "/" or system-dir import.
  const allow = process.env.FACTORY_IMPORT_ALLOW_OUTSIDE_HOME === "1";
  const home = os.homedir();
  if (!allow && !p.startsWith(`${home}/`) && p !== home) {
    throw new ImportError(
      "path_outside_home",
      `path outside $HOME (${home}); set FACTORY_IMPORT_ALLOW_OUTSIDE_HOME=1 to override`,
    );
  }
  if (!existsSync(p)) {
    throw new ImportError("bad_path", `path does not exist: ${p}`);
  }
  const st = statSync(p);
  if (!st.isDirectory()) {
    throw new ImportError("bad_path", `path is not a directory: ${p}`);
  }
}

/**
 * Inspect the workdir's `origin` remote and return its URL when it points
 * at GitHub (https://github.com/owner/repo or git@github.com:owner/repo).
 * Other hosts and missing remotes return null. The repo is considered
 * already-published when this is non-null — `publishToGithub` is skipped
 * and the existing remote is surfaced on the project header.
 */
async function readGithubOriginRemote(workdirPath: string): Promise<string | null> {
  const proc = bunSpawn({
    cmd: ["git", "remote", "get-url", "origin"],
    cwd: workdirPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const url = stdout.trim();
  if (!url) return null;
  if (url.startsWith("https://github.com/")) return url;
  if (/^git@github\.com:[^/]+\/.+$/.test(url)) return url;
  return null;
}

async function isGitRepoWithCommits(workdirPath: string): Promise<boolean> {
  // git rev-parse --is-inside-work-tree handles the "is repo" check; HEAD
  // dereference handles the "has at least one commit" check.
  const proc = bunSpawn({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: workdirPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return code === 0;
}

async function cloneRepo(url: string, dest: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLONE_TIMEOUT_MS);
  try {
    const proc = bunSpawn({
      cmd: ["git", "clone", "--no-tags", url, dest],
      stdout: "pipe",
      stderr: "pipe",
      // Disable any interactive credential prompts so the daemon can never
      // hang waiting on stdin. Private clones fail fast and the operator
      // falls back to path-import.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
      },
      signal: ctrl.signal,
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (ctrl.signal.aborted) {
      throw new ImportError("clone_timeout", `git clone exceeded ${CLONE_TIMEOUT_MS / 1000}s`);
    }
    if (code !== 0) {
      throw new ImportError("clone_failed", `git clone failed: ${stderr.trim().slice(0, 400)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function writeSkeleton(
  workdirPath: string,
  meta: {
    projectId: string;
    slug: string;
    ceremony: ImportCeremony;
    role: ImportRole;
    source: { kind: "url"; url: string } | { kind: "path"; path: string };
  },
): Promise<void> {
  // Each mkdir is recursive and { recursive: true } is a no-op when the dir
  // already exists, so re-import is harmless from a filesystem standpoint.
  await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
  await mkdir(path.join(workdirPath, ".factory", "audits"), { recursive: true });
  await mkdir(path.join(workdirPath, ".factory", "notes"), { recursive: true });

  const metaPath = path.join(workdirPath, ".factory", "meta.yaml");
  if (!existsSync(metaPath)) {
    await writeFile(
      metaPath,
      YAML.stringify({
        projectId: meta.projectId,
        slug: meta.slug,
        ceremony: meta.ceremony,
        role: meta.role,
        imported: new Date().toISOString(),
        source: meta.source,
      }),
      "utf8",
    );
  }

  const ignorePath = path.join(workdirPath, ".factory", ".gitignore");
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, "runs/\n", "utf8");
  }
}

export async function importFromUrl(
  config: FactoryConfig,
  db: Db,
  input: ImportFromUrlInput,
): Promise<ImportResult> {
  validateUrl(input.url);
  const baseSlug = input.slug ? slugify(input.slug) : deriveSlugFromUrl(input.url);
  if (!baseSlug) throw new ImportError("bad_url", "could not derive a slug from URL");
  const slug = await pickUniqueSlug(db, baseSlug);

  const projectsRoot = path.join(config.workdir, "projects");
  const workdirPath = path.join(projectsRoot, slug);
  if (existsSync(workdirPath)) {
    throw new ImportError("slug_taken", `target path already exists: ${workdirPath}`);
  }
  await mkdir(projectsRoot, { recursive: true });

  try {
    await cloneRepo(input.url, workdirPath);
    if (!(await isGitRepoWithCommits(workdirPath))) {
      throw new ImportError("no_commits", "clone produced a repo with no commits");
    }
    return await registerProject(db, {
      workdirPath,
      slug,
      name: input.name,
      ceremony: input.ceremony,
      role: input.role,
      source: { kind: "url", url: input.url },
    });
  } catch (err) {
    // Clean up partial clone on any failure, so the next attempt can re-use
    // the same target path.
    try {
      await rm(workdirPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export async function importFromPath(
  _config: FactoryConfig,
  db: Db,
  input: ImportFromPathInput,
): Promise<ImportResult> {
  validatePath(input.workdirPath);
  if (!(await isGitRepoWithCommits(input.workdirPath))) {
    throw new ImportError(
      "not_a_repo",
      `path is not a git repo with commits: ${input.workdirPath}`,
    );
  }

  // Reject if another project already points at this exact path.
  const existing = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.workdirPath, input.workdirPath))
    .get();
  if (existing) {
    throw new ImportError(
      "path_already_imported",
      `path already registered as project ${existing.slug} (${existing.id.slice(0, 8)})`,
    );
  }

  const baseSlug = input.slug ? slugify(input.slug) : deriveSlugFromPath(input.workdirPath);
  if (!baseSlug) throw new ImportError("bad_path", "could not derive a slug from path");
  const slug = await pickUniqueSlug(db, baseSlug);

  return registerProject(db, {
    workdirPath: input.workdirPath,
    slug,
    name: input.name,
    ceremony: input.ceremony,
    role: input.role,
    source: { kind: "path", path: input.workdirPath },
  });
}

async function registerProject(
  db: Db,
  args: {
    workdirPath: string;
    slug: string;
    name?: string;
    ceremony: ImportCeremony;
    role: ImportRole;
    source: { kind: "url"; url: string } | { kind: "path"; path: string };
  },
): Promise<ImportResult> {
  const projectId = createId();
  const now = Date.now();
  await writeSkeleton(args.workdirPath, {
    projectId,
    slug: args.slug,
    ceremony: args.ceremony,
    role: args.role,
    source: args.source,
  });

  // Best-effort license read from package.json or LICENSE file. Null when
  // neither is present or parseable; the operator can set it manually later.
  const license = await readLicenseHint(args.workdirPath);

  // Detect an existing github origin so the publish-to-github affordance
  // is hidden for repos that are already on GitHub. URL-clone imports
  // always have a github origin if the source URL was github; path
  // imports get whatever the local checkout has.
  const githubRemote = await readGithubOriginRemote(args.workdirPath);

  await db.insert(schema.projects).values({
    id: projectId,
    slug: args.slug,
    name: (args.name ?? args.slug).slice(0, 80),
    ideaId: null,
    ceremony: args.ceremony,
    role: args.role,
    license,
    tag: "active",
    workdirPath: args.workdirPath,
    createdAt: now,
    lastActivityAt: now,
    model: null,
    githubRemote,
  });

  return { projectId, slug: args.slug, workdirPath: args.workdirPath };
}

/**
 * Best-effort SPDX license read. Looks at package.json's `license` field
 * first (most JS/TS projects have it), then falls back to an SPDX-ish
 * pattern in a top-level LICENSE file. Returns null if neither yields
 * something usable.
 */
async function readLicenseHint(workdirPath: string): Promise<string | null> {
  const pkgPath = path.join(workdirPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(pkgPath, "utf8"));
      if (typeof pkg.license === "string" && pkg.license.length > 0) {
        return pkg.license;
      }
    } catch {
      // fall through
    }
  }
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    const p = path.join(workdirPath, name);
    if (!existsSync(p)) continue;
    try {
      const text = await (await import("node:fs/promises")).readFile(p, "utf8");
      const head = text.slice(0, 400).toLowerCase();
      if (head.includes("mit license")) return "MIT";
      if (head.includes("apache license") && head.includes("version 2")) return "Apache-2.0";
      if (head.includes("mozilla public license") && head.includes("2.0")) return "MPL-2.0";
      if (head.includes("gnu general public license") && head.includes("version 3")) {
        return "GPL-3.0";
      }
      if (head.includes("gnu general public license") && head.includes("version 2")) {
        return "GPL-2.0";
      }
      if (head.includes("gnu affero general public license")) return "AGPL-3.0";
      if (head.includes("bsd 3-clause")) return "BSD-3-Clause";
      if (head.includes("bsd 2-clause")) return "BSD-2-Clause";
      if (head.includes("the unlicense")) return "Unlicense";
      // Unrecognized — return a marker rather than null so the operator
      // sees that there *is* a license file, just not one we identified.
      return "custom";
    } catch {
      // fall through
    }
  }
  return null;
}
