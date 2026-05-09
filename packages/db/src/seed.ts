import { readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { eq, sql } from "drizzle-orm";
import yaml from "js-yaml";
import { createDb, type Db, getDefaultDbPath } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { prompts, rubricVersions } from "./schema.ts";

const repoRoot = path.resolve(import.meta.dir, "../../..");

// Rubric matrix: four owner-* rubrics keyed on ceremony, plus a single
// rubric-contributor that handles all contributor work regardless of
// upstream ceremony. All five must be seeded as active simultaneously
// — orchestrate.ts picks the right one per (intentCeremony, intentRole).
const RUBRIC_FILES: string[] = [
  path.join(repoRoot, "rubrics/rubric-owner-tinker.yaml"),
  path.join(repoRoot, "rubrics/rubric-owner-personal.yaml"),
  path.join(repoRoot, "rubrics/rubric-owner-shared.yaml"),
  path.join(repoRoot, "rubrics/rubric-owner-production.yaml"),
  path.join(repoRoot, "rubrics/rubric-contributor.yaml"),
];
const PROMPT_KEY = "triage-prompt-v1";
const FOLLOWUP_PROMPT_KEY = "triage-followup-v1";
const CONTRIBUTOR_PROMPT_KEY = "triage-contributor-v1";
const AUDIT_BRIDGE_PROMPT_KEY = "audit-bridge-v1";
const FEEDBACK_PROMPT_KEY = "feedback-iterate-v1";

const PLAN_PROMPT_FILES: Array<{ key: string; file: string }> = [
  { key: "plan-project-spec-v1", file: "prompts/plan-project-spec-v1.md" },
  { key: "plan-task-plan-v1", file: "prompts/plan-task-plan-v1.md" },
  { key: "plan-refinement-v1", file: "prompts/plan-refinement-v1.md" },
  { key: "plan-feature-plan-v1", file: "prompts/plan-feature-plan-v1.md" },
  { key: "plan-project-vision-v1", file: "prompts/plan-project-vision-v1.md" },
];

const ALL_PROMPT_FILES: Array<{ key: string; file: string }> = [
  { key: PROMPT_KEY, file: "prompts/triage-prompt-v1.md" },
  { key: FOLLOWUP_PROMPT_KEY, file: "prompts/triage-followup-v1.md" },
  { key: CONTRIBUTOR_PROMPT_KEY, file: "prompts/triage-contributor-v1.md" },
  ...PLAN_PROMPT_FILES,
  { key: AUDIT_BRIDGE_PROMPT_KEY, file: "prompts/audit-bridge-v1.md" },
  { key: FEEDBACK_PROMPT_KEY, file: "prompts/feedback-iterate-v1.md" },
];

interface RubricYaml {
  id: string;
  version: number;
  agent_invocation?: { prompt_key?: string };
}

/**
 * Upsert a prompt by key. If no row exists for the key, insert v1 with the
 * given content. If a row exists and the highest-version row's content
 * matches the file, leave it alone. Otherwise insert a new row at
 * `max(version) + 1` and mark only that row active.
 *
 * This is how prompt-file edits propagate to existing DBs without
 * hand-bumping integers in the seed for every change. The
 * `(promptKey, version)` history is preserved for audit; the active
 * pointer always reflects what's on disk.
 */
async function upsertPromptFromFile(db: Db, key: string, content: string, now: number) {
  const rows = await db
    .select()
    .from(prompts)
    .where(eq(prompts.promptKey, key))
    .orderBy(prompts.version)
    .all();

  if (rows.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey: key,
      version: 1,
      content,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${key}@1`);
  } else {
    const head = rows[rows.length - 1];
    if (!head) {
      throw new Error(`unreachable: rows.length > 0 but head is undefined for ${key}`);
    }
    if (head.content === content) {
      console.log(`  · prompt ${key}@${head.version} unchanged`);
    } else {
      const nextVersion = head.version + 1;
      await db.insert(prompts).values({
        id: createId(),
        promptKey: key,
        version: nextVersion,
        content,
        active: false, // active flag flipped below in a single statement per key
        createdAt: now,
      });
      console.log(`  + prompt ${key}@${nextVersion} (content drift from @${head.version})`);
    }
  }

  // Ensure exactly one active row per key — the highest-version one.
  await db.update(prompts).set({ active: false }).where(eq(prompts.promptKey, key));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${key} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${key})`,
    );
}

async function main() {
  const target = process.env.FACTORY_DB ?? getDefaultDbPath();
  console.log(`seeding → ${target}`);

  runMigrations(target);

  const db = createDb(target);

  // Load all rubric YAMLs upfront so we can validate before touching the DB.
  const rubricRaws: Array<{ file: string; raw: string; parsed: RubricYaml }> = [];
  for (const file of RUBRIC_FILES) {
    const raw = await readFile(file, "utf8");
    const parsed = yaml.load(raw) as RubricYaml;
    if (!parsed?.id || typeof parsed.version !== "number") {
      throw new Error(`invalid rubric: missing id or version (${file})`);
    }
    rubricRaws.push({ file, raw, parsed });
  }

  const now = Date.now();

  // Upsert every prompt file by content drift — see upsertPromptFromFile.
  for (const { key, file } of ALL_PROMPT_FILES) {
    const content = await readFile(path.join(repoRoot, file), "utf8");
    await upsertPromptFromFile(db, key, content, now);
  }

  // Deactivate any legacy rubric keys that are no longer part of the
  // matrix (e.g. `rubric-me-tinker` from before the ceremony × role
  // split). Rows stay in the DB for audit history; they just shouldn't
  // surface in the active rubric list.
  const expectedKeys = rubricRaws.map((r) => r.parsed.id);
  await db
    .update(rubricVersions)
    .set({ active: false })
    .where(sql`${rubricVersions.rubricKey} NOT IN (${sql.join(expectedKeys, sql`, `)})`);

  // Rubrics: upsert each of the 5 (4 owner-* + 1 contributor) and mark
  // the highest-version row of each key as active. Multiple active
  // rubrics is the new normal — orchestrate.ts selects per request.
  for (const { raw, parsed } of rubricRaws) {
    const rubricPromptKey = parsed.agent_invocation?.prompt_key ?? PROMPT_KEY;
    const existingRubric = await db
      .select({ id: rubricVersions.id })
      .from(rubricVersions)
      .where(eq(rubricVersions.rubricKey, parsed.id))
      .all();

    if (existingRubric.length === 0) {
      await db.insert(rubricVersions).values({
        id: createId(),
        rubricKey: parsed.id,
        version: parsed.version,
        yaml: raw,
        promptKey: rubricPromptKey,
        active: true,
        createdAt: now,
        message: "seed: initial import",
      });
      console.log(`  + rubric ${parsed.id}@${parsed.version}`);
    } else {
      console.log(`  · rubric ${parsed.id} already present (${existingRubric.length} row(s))`);
    }

    await db
      .update(rubricVersions)
      .set({ active: false })
      .where(eq(rubricVersions.rubricKey, parsed.id));
    await db
      .update(rubricVersions)
      .set({ active: true })
      .where(
        sql`${rubricVersions.rubricKey} = ${parsed.id} AND ${rubricVersions.version} = (SELECT MAX(${rubricVersions.version}) FROM ${rubricVersions} WHERE ${rubricVersions.rubricKey} = ${parsed.id})`,
      );
  }

  // Verify acceptance: exactly one active rubric and one active prompt per key
  const activeRubrics = await db
    .select({ key: rubricVersions.rubricKey, version: rubricVersions.version })
    .from(rubricVersions)
    .where(eq(rubricVersions.active, true))
    .all();
  const activePrompts = await db
    .select({ key: prompts.promptKey, version: prompts.version })
    .from(prompts)
    .where(eq(prompts.active, true))
    .all();

  console.log(`\nactive rubrics: ${activeRubrics.length}`);
  for (const r of activeRubrics) console.log(`  - ${r.key}@${r.version}`);
  console.log(`active prompts: ${activePrompts.length}`);
  for (const p of activePrompts) console.log(`  - ${p.key}@${p.version}`);

  // Five active rubrics (4 owner-* + 1 contributor); one active prompt per key.
  const expectedRubricKeys = new Set(rubricRaws.map((r) => r.parsed.id));
  const expectedPromptKeys = new Set(ALL_PROMPT_FILES.map((p) => p.key));
  const activePromptKeys = new Set(activePrompts.map((p) => p.key));
  const activeRubricKeys = new Set(activeRubrics.map((r) => r.key));
  const missingKeys = [...expectedPromptKeys].filter((k) => !activePromptKeys.has(k));
  const missingRubricKeys = [...expectedRubricKeys].filter((k) => !activeRubricKeys.has(k));
  if (
    activeRubrics.length !== expectedRubricKeys.size ||
    missingRubricKeys.length > 0 ||
    activePrompts.length !== expectedPromptKeys.size ||
    missingKeys.length > 0
  ) {
    throw new Error(
      `seed acceptance failed: expected active rubrics [${[...expectedRubricKeys].join(", ")}] and active prompts [${[...expectedPromptKeys].join(", ")}]`,
    );
  }
}

await main();
