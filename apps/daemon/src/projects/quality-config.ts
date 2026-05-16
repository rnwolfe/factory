import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { commitAllChanges, isWorktreeClean } from "@factory/runtime";
import { isNull } from "drizzle-orm";

/**
 * Marker line on Factory-seeded `.factory/quality.yaml` files. Bumped
 * whenever the default template changes; the migration keys its
 * "already current" detection off this so it never re-touches a project
 * that's on the live default.
 */
export const QUALITY_DEFAULT_MARKER = "# factory:quality-default v2";

/**
 * Current default `.factory/quality.yaml`. Checks delegate to the project
 * Makefile so Factory stays stack-agnostic — bootstrap runs before any
 * project code exists and cannot know the stack. See bootstrap.ts.
 */
export const DEFAULT_QUALITY_YAML = `${QUALITY_DEFAULT_MARKER}
# Factory quality checks. Each command runs in the run's worktree after
# the agent declares done and before the merge into main. Failures are
# informational (they do not block the merge).
#
# These delegate to the project Makefile so quality stays stack-agnostic —
# wire the real commands into the Makefile targets, not here.
checks:
  - name: typecheck
    command: make typecheck
    timeoutSeconds: 300
  - name: lint
    command: make lint
    timeoutSeconds: 120
  - name: test
    command: make test
    timeoutSeconds: 600
`;

/**
 * Stub Makefile seeded into new projects: no-op quality targets the agent
 * wires to the real stack as it builds. Stubs exit 0 so a fresh project's
 * quality checks pass until they're filled in.
 */
export const DEFAULT_MAKEFILE = `# Factory quality interface: make typecheck, make lint, and make test
# run as quality checks after every run (see .factory/quality.yaml).
# Replace the stub recipes below with the real commands for this stack.
.PHONY: typecheck lint test

typecheck:
\t@echo "make typecheck: no checks configured yet"

lint:
\t@echo "make lint: no checks configured yet"

test:
\t@echo "make test: no checks configured yet"
`;

/**
 * Prior default quality.yaml templates Factory has seeded into projects. A
 * project whose quality.yaml matches one of these (trimmed) byte-for-byte
 * was never customized — the migration may safely rewrite it. Append-only:
 * never edit or remove an entry, or projects on that vintage stop migrating.
 */
export const LEGACY_QUALITY_YAML_DEFAULTS: readonly string[] = [
  // v1 — hard-coded bun toolchain, seeded before the Makefile interface.
  `# Factory quality checks. Each command runs in the run's worktree
# after the agent declares done and before the merge into main.
# Failures are informational in v0.2 (do not block merge).
checks:
  - name: typecheck
    command: bun run typecheck
    timeoutSeconds: 300
  - name: lint
    command: bun run check
    timeoutSeconds: 120
  - name: test
    command: bun test
    timeoutSeconds: 600
`,
];

const legacyDefaultSet = new Set(LEGACY_QUALITY_YAML_DEFAULTS.map((s) => s.trim()));

export interface QualityMigrationDeps {
  db: Db;
  gitAuthor: { name: string; email: string };
}

/**
 * Migrate repo-canonical quality config for projects bootstrapped before the
 * Makefile quality interface. Idempotent and deliberately conservative:
 *
 *  - A project's `.factory/quality.yaml` is rewritten ONLY when it is still
 *    byte-identical (trimmed) to a known prior Factory default — proof the
 *    operator never customized it. Customized configs, and configs already
 *    carrying the current marker, are left untouched.
 *  - A stub Makefile is seeded only when the project has none; a real one is
 *    never overwritten. Factory cannot know the project's stack — the agent
 *    wires the targets, and a missing target surfaces as an informational
 *    quality failure (checks are non-blocking), not a silent break.
 *  - Changes are committed to the project repo, but only when its working
 *    tree was already clean — we never fold unrelated operator work into the
 *    migration commit. A dirty project is skipped and retried next boot.
 *
 * Returns the number of projects migrated. Safe to run on every daemon boot.
 */
export async function migrateQualityConfigs(deps: QualityMigrationDeps): Promise<number> {
  const { db, gitAuthor } = deps;
  const projects = await db
    .select({ slug: schema.projects.slug, workdirPath: schema.projects.workdirPath })
    .from(schema.projects)
    .where(isNull(schema.projects.archivedAt))
    .all();

  let migrated = 0;
  for (const project of projects) {
    try {
      if (await migrateOneProject(project.workdirPath, gitAuthor)) migrated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[quality-migration] skipped ${project.slug}: ${msg}`);
    }
  }
  return migrated;
}

async function migrateOneProject(
  workdirPath: string,
  gitAuthor: { name: string; email: string },
): Promise<boolean> {
  if (!existsSync(workdirPath)) return false;

  const qualityPath = path.join(workdirPath, ".factory", "quality.yaml");
  // Absent quality.yaml means the operator deliberately runs no checks — bootstrap
  // always seeds one, so absence is a removal. Respect it.
  if (!existsSync(qualityPath)) return false;

  const current = await readFile(qualityPath, "utf8");
  // Already on a Factory-managed default — nothing to do.
  if (current.includes(QUALITY_DEFAULT_MARKER)) return false;
  // Diverged from every known default — the operator customized it. Hands off.
  if (!legacyDefaultSet.has(current.trim())) return false;

  // Refuse to commit into a dirty tree — we'd sweep unrelated work into the
  // migration commit. Leave it; the next clean boot retries.
  if (!(await isWorktreeClean(workdirPath))) {
    console.warn(`[quality-migration] ${path.basename(workdirPath)}: working tree dirty — skipped`);
    return false;
  }

  await writeFile(qualityPath, DEFAULT_QUALITY_YAML, "utf8");
  const makefilePath = path.join(workdirPath, "Makefile");
  if (!existsSync(makefilePath)) {
    await writeFile(makefilePath, DEFAULT_MAKEFILE, "utf8");
  }

  await commitAllChanges(workdirPath, "chore: migrate quality checks to make targets", gitAuthor);
  return true;
}
