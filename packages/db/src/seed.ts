import { readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { eq, sql } from "drizzle-orm";
import yaml from "js-yaml";
import { createDb, getDefaultDbPath } from "./client.ts";
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
const PROMPT_FILE = path.join(repoRoot, "prompts/triage-prompt-v1.md");
const FOLLOWUP_PROMPT_FILE = path.join(repoRoot, "prompts/triage-followup-v1.md");
const FOLLOWUP_PROMPT_KEY = "triage-followup-v1";
const CONTRIBUTOR_PROMPT_FILE = path.join(repoRoot, "prompts/triage-contributor-v1.md");
const CONTRIBUTOR_PROMPT_KEY = "triage-contributor-v1";

const PLAN_PROMPT_FILES: Array<{ key: string; file: string }> = [
  { key: "plan-project-spec-v1", file: "prompts/plan-project-spec-v1.md" },
  { key: "plan-task-plan-v1", file: "prompts/plan-task-plan-v1.md" },
  { key: "plan-refinement-v1", file: "prompts/plan-refinement-v1.md" },
  { key: "plan-feature-plan-v1", file: "prompts/plan-feature-plan-v1.md" },
  { key: "plan-project-vision-v1", file: "prompts/plan-project-vision-v1.md" },
];

const AUDIT_BRIDGE_PROMPT_FILE = path.join(repoRoot, "prompts/audit-bridge-v1.md");
const AUDIT_BRIDGE_PROMPT_KEY = "audit-bridge-v1";

const FEEDBACK_PROMPT_FILE = path.join(repoRoot, "prompts/feedback-iterate-v1.md");
const FEEDBACK_PROMPT_KEY = "feedback-iterate-v1";

interface RubricYaml {
  id: string;
  version: number;
  agent_invocation?: { prompt_key?: string };
}

async function main() {
  const target = process.env.FACTORY_DB ?? getDefaultDbPath();
  console.log(`seeding → ${target}`);

  runMigrations(target);

  const db = createDb(target);

  const [promptContent, followupContent, contributorPromptContent] = await Promise.all([
    readFile(PROMPT_FILE, "utf8"),
    readFile(FOLLOWUP_PROMPT_FILE, "utf8"),
    readFile(CONTRIBUTOR_PROMPT_FILE, "utf8"),
  ]);

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

  const promptKey = "triage-prompt-v1";
  const now = Date.now();

  // Prompt: insert if missing, then set as the only active row for this key.
  const existingPrompt = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(eq(prompts.promptKey, promptKey))
    .all();

  if (existingPrompt.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey,
      version: 1,
      content: promptContent,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${promptKey}@1`);
  } else {
    console.log(`  · prompt ${promptKey} already present (${existingPrompt.length} row(s))`);
  }

  // Ensure exactly one active prompt per key.
  await db.update(prompts).set({ active: false }).where(eq(prompts.promptKey, promptKey));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${promptKey} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${promptKey})`,
    );

  // Follow-up prompt: same shape as the triage prompt — its own key, one active
  // version. Re-triage runs after operator comments use this template.
  const existingFollowup = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(eq(prompts.promptKey, FOLLOWUP_PROMPT_KEY))
    .all();

  if (existingFollowup.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey: FOLLOWUP_PROMPT_KEY,
      version: 1,
      content: followupContent,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${FOLLOWUP_PROMPT_KEY}@1`);
  } else {
    console.log(
      `  · prompt ${FOLLOWUP_PROMPT_KEY} already present (${existingFollowup.length} row(s))`,
    );
  }
  await db.update(prompts).set({ active: false }).where(eq(prompts.promptKey, FOLLOWUP_PROMPT_KEY));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${FOLLOWUP_PROMPT_KEY} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${FOLLOWUP_PROMPT_KEY})`,
    );

  // Plan-iteration prompts (one per kind). Same upsert shape as triage.
  for (const { key, file } of PLAN_PROMPT_FILES) {
    const filePath = path.join(repoRoot, file);
    const content = await readFile(filePath, "utf8");
    const existing = await db
      .select({ id: prompts.id })
      .from(prompts)
      .where(eq(prompts.promptKey, key))
      .all();
    if (existing.length === 0) {
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
      console.log(`  · prompt ${key} already present (${existing.length} row(s))`);
    }
    await db.update(prompts).set({ active: false }).where(eq(prompts.promptKey, key));
    await db
      .update(prompts)
      .set({ active: true })
      .where(
        sql`${prompts.promptKey} = ${key} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${key})`,
      );
  }

  // Feedback iteration prompt: agent reply on feedback threads.
  // Same upsert shape as the plan prompts.
  const feedbackContent = await readFile(FEEDBACK_PROMPT_FILE, "utf8");
  const existingFeedback = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(eq(prompts.promptKey, FEEDBACK_PROMPT_KEY))
    .all();
  if (existingFeedback.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey: FEEDBACK_PROMPT_KEY,
      version: 1,
      content: feedbackContent,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${FEEDBACK_PROMPT_KEY}@1`);
  } else {
    console.log(
      `  · prompt ${FEEDBACK_PROMPT_KEY} already present (${existingFeedback.length} row(s))`,
    );
  }
  await db.update(prompts).set({ active: false }).where(eq(prompts.promptKey, FEEDBACK_PROMPT_KEY));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${FEEDBACK_PROMPT_KEY} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${FEEDBACK_PROMPT_KEY})`,
    );

  // Audit bridge prompt: small routing call invoked by audits.promoteFindings.
  // Same upsert shape as the plan prompts.
  const auditBridgeContent = await readFile(AUDIT_BRIDGE_PROMPT_FILE, "utf8");
  const existingAuditBridge = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(eq(prompts.promptKey, AUDIT_BRIDGE_PROMPT_KEY))
    .all();
  if (existingAuditBridge.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey: AUDIT_BRIDGE_PROMPT_KEY,
      version: 1,
      content: auditBridgeContent,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${AUDIT_BRIDGE_PROMPT_KEY}@1`);
  } else {
    console.log(
      `  · prompt ${AUDIT_BRIDGE_PROMPT_KEY} already present (${existingAuditBridge.length} row(s))`,
    );
  }
  await db
    .update(prompts)
    .set({ active: false })
    .where(eq(prompts.promptKey, AUDIT_BRIDGE_PROMPT_KEY));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${AUDIT_BRIDGE_PROMPT_KEY} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${AUDIT_BRIDGE_PROMPT_KEY})`,
    );

  // Contributor triage prompt: separate prompt key for the contributor flow,
  // since contributor inputs/outputs differ from owner-mode triage.
  const existingContribPrompt = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(eq(prompts.promptKey, CONTRIBUTOR_PROMPT_KEY))
    .all();
  if (existingContribPrompt.length === 0) {
    await db.insert(prompts).values({
      id: createId(),
      promptKey: CONTRIBUTOR_PROMPT_KEY,
      version: 1,
      content: contributorPromptContent,
      active: true,
      createdAt: now,
    });
    console.log(`  + prompt ${CONTRIBUTOR_PROMPT_KEY}@1`);
  } else {
    console.log(
      `  · prompt ${CONTRIBUTOR_PROMPT_KEY} already present (${existingContribPrompt.length} row(s))`,
    );
  }
  await db
    .update(prompts)
    .set({ active: false })
    .where(eq(prompts.promptKey, CONTRIBUTOR_PROMPT_KEY));
  await db
    .update(prompts)
    .set({ active: true })
    .where(
      sql`${prompts.promptKey} = ${CONTRIBUTOR_PROMPT_KEY} AND ${prompts.version} = (SELECT MAX(${prompts.version}) FROM ${prompts} WHERE ${prompts.promptKey} = ${CONTRIBUTOR_PROMPT_KEY})`,
    );

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
    const rubricPromptKey = parsed.agent_invocation?.prompt_key ?? promptKey;
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

  // Verify acceptance: exactly one active rubric and one active prompt
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
  const expectedPromptKeys = new Set([
    promptKey,
    FOLLOWUP_PROMPT_KEY,
    CONTRIBUTOR_PROMPT_KEY,
    ...PLAN_PROMPT_FILES.map((p) => p.key),
    AUDIT_BRIDGE_PROMPT_KEY,
    FEEDBACK_PROMPT_KEY,
  ]);
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
