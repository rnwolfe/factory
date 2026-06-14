import { readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { eq, sql } from "drizzle-orm";
import yaml from "js-yaml";
import { createDb, type Db, getDefaultDbPath } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { prompts, rubricVersions, type TaskTemplateDraft, taskTemplates } from "./schema.ts";

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
const SPEC_DECOMPOSE_PROMPT_KEY = "spec-decompose-v1";

const PLAN_PROMPT_FILES: Array<{ key: string; file: string }> = [
  { key: "plan-project-spec-v1", file: "prompts/plan-project-spec-v1.md" },
  { key: "plan-task-plan-v1", file: "prompts/plan-task-plan-v1.md" },
  { key: "plan-refinement-v1", file: "prompts/plan-refinement-v1.md" },
  { key: "plan-feature-plan-v1", file: "prompts/plan-feature-plan-v1.md" },
  { key: "plan-project-vision-v1", file: "prompts/plan-project-vision-v1.md" },
  { key: "plan-task-template-v1", file: "prompts/plan-task-template-v1.md" },
];

const ALL_PROMPT_FILES: Array<{ key: string; file: string }> = [
  { key: PROMPT_KEY, file: "prompts/triage-prompt-v1.md" },
  { key: FOLLOWUP_PROMPT_KEY, file: "prompts/triage-followup-v1.md" },
  { key: CONTRIBUTOR_PROMPT_KEY, file: "prompts/triage-contributor-v1.md" },
  ...PLAN_PROMPT_FILES,
  { key: AUDIT_BRIDGE_PROMPT_KEY, file: "prompts/audit-bridge-v1.md" },
  { key: FEEDBACK_PROMPT_KEY, file: "prompts/feedback-iterate-v1.md" },
  { key: SPEC_DECOMPOSE_PROMPT_KEY, file: "prompts/spec-decompose-v1.md" },
];

/**
 * Task templates seeded on every daemon start. Slug is stable; the upsert
 * only writes if the seeded draft is meaningfully newer than what's in the
 * DB (so operator-edits via the form editor survive seed). Each template
 * here is intentionally generic — per-project specifics live in the
 * project's own `skills/<name>/SKILL.md` files, and the templates'
 * agent-rendered sections defer to those at instantiate time.
 */
const SEEDED_TEMPLATES: Array<{ slug: string; draft: TaskTemplateDraft }> = [
  {
    slug: "release-project",
    draft: {
      kind: "task_template",
      name: "Release Project",
      description:
        "Cut a release of the current project — version bump, changelog, annotated tag, push instructions.",
      titlePattern: "Release {projectName} {version}",
      labels: ["release"],
      priority: "med",
      estimate: "small",
      confirmInInbox: true,
      variables: [
        {
          key: "version",
          label: "Version",
          description: "The new version, e.g. v0.5.0. Match the project's existing tag format.",
          // Model-resolved from the change set — the operator isn't asked for a
          // number. An explicit operator value still overrides (see ADR-008).
          required: false,
          default: null,
          resolver: {
            kind: "agent",
            prompt:
              "Determine the next version from the commits since the last v*.*.* tag, under semver-driven-by-conventional-commits (feat: → minor, fix:/chore:/docs:/refactor:/test: → patch, a `!` type or `BREAKING CHANGE:` footer → major; pre-1.0 projects stay on 0.x and treat feat as minor). Match the project's existing tag format (leading `v` if prior tags use it). If there is no prior tag, propose v0.1.0. Return ONLY the version string, e.g. v0.23.0.",
          },
        },
        {
          key: "notes",
          label: "Operator notes (optional)",
          description: "Any framing the operator wants in the changelog beyond the commit summary.",
          required: false,
          default: "",
        },
      ],
      sections: [
        {
          heading: "What's new",
          kind: "agent",
          body: `Draft the changelog entry prose for version **{version}** of this project — the operator-visible "what's new", to be reviewed in the inbox before the release is cut.

Read the commits since the last v*.*.* tag (\`git log <last-tag>..HEAD --pretty=format:'%h %s'\`), the task titles/run summaries behind them where they clarify intent, and the prior changelog entry to match tone and section layout.

Write a Keep-a-Changelog-style entry body: a one-line intro paragraph if warranted, then \`### Added\` / \`### Changed\` / \`### Fixed\` sections (skip empty ones), one bullet per operator-visible change. **Operator-visible only** — fold in routine chores/refactors only if a user would notice. Fold in the operator's extra framing if provided: {notes}.

Output the markdown entry body only (no \`## v{version}\` header — that's added at write time, no fenced JSON, no preamble). This text becomes the changelog entry the release run writes.`,
        },
        {
          heading: "Acceptance",
          kind: "static",
          body: `- [ ] Used the project's own release tooling if it has any (a release script, a \`release\` package.json/Make/just target, or \`skills/release/SKILL.md\`) — only hand-rolled the steps if the project genuinely has none.
- [ ] Project gates ran and **passed** before the tag: typecheck + lint + tests. **No checks-skipping flags** (\`--skip-checks\`, \`--no-verify\`, \`--no-test\`).
- [ ] Version bumped to **{version}** in every file that carries one (root \`package.json\` + workspaces, or the project's equivalent).
- [ ] Changelog entry prepended to the project's release-notes file (e.g. \`CHANGELOG.md\`); body = the confirmed **What's new** prose above.
- [ ] Single release commit on the primary branch: \`chore(release): {version}\`.
- [ ] Annotated git tag \`{version}\` at the release commit, carrying the changelog entry in the tag message.
- [ ] **\`main\` and the tag \`{version}\` pushed to origin** — the inbox confirmation authorized this push.
- [ ] Any post-tag step (deploy, \`factory upgrade\`, npm publish) called out in the run summary.`,
        },
        {
          heading: "Recipe",
          kind: "agent",
          body: `You are cutting a release for this project. This release was confirmed by the operator in the inbox — that confirmation **authorizes the push**, so you push \`main\` and the tag at the end (unlike an ordinary run, which never pushes).

The version **{version}** was resolved from the change set and confirmed in the inbox — treat it as authoritative; don't re-derive or change it. The **What's new** section above is the operator-confirmed changelog prose — use it as the entry body, don't rewrite from scratch.

# Use the project's own release tooling — do not improvise if it exists

Find the project's real release path before doing anything by hand, in this order:

1. **A release script** — e.g. \`scripts/release.ts\`, a \`release\` entry in \`package.json\` scripts, or a Make/just \`release\` target. **Run it with its push flag and its checks ON** — e.g. \`bun scripts/release.ts --push\`. **Never** pass a checks-skipping flag (\`--skip-checks\` / \`--no-verify\` / \`--no-test\`): the gates running before the tag is the entire point. If the script computes its own version, reconcile it to **{version}** and surface any mismatch in your \`summary\`.
2. **\`skills/release/SKILL.md\`** if present — follow it verbatim (it may itself call the release script). If a step looks wrong, surface it in your \`summary\` instead of improvising.
3. **The generic recipe below** — only if the project has neither.

# Generic recipe (only when the project has no release tooling)

1. Preconditions: clean working tree, on the primary branch (\`main\`), in sync with \`origin\`.
2. **Run the project's gates and STOP if any fail** — typecheck, lint, and tests (whatever the project defines, e.g. \`bun run typecheck && bun run check && bun test\`). Do not skip them; do not \`--no-verify\` the commit.
3. Update **{version}** in every file that carries the project's version (root \`package.json\` + workspaces, a \`VERSION\` file, etc.).
4. Prepend a \`## {version} — <today>\` section to the changelog; body = the **What's new** prose above (lightly reconcile against the actual commits if anything drifted).
5. Single commit: \`chore(release): {version}\`.
6. Annotated tag: \`git tag -a {version} -m "<version>\\n\\n<changelog entry body>"\`.
7. **Push** \`main\` and the tag (\`git push origin <branch>\` then \`git push origin {version}\`). The inbox confirm authorized this — do not stop at "printing the commands." Then call out any post-tag step (deploy, \`factory upgrade\`, npm publish) in your \`summary\`.

# Reading list

- The project's release tooling: a release script, \`package.json\` scripts, \`skills/release/SKILL.md\` — find the real path before improvising.
- Recent commit log (\`git log <last-tag>..HEAD\`) so the changelog is accurate.
- The project's \`AGENTS.md\` for any release-related contracts.
- The prior changelog entry — match its tone and section layout.`,
        },
      ],
    },
  },
];

/**
 * Upsert a seeded task template. Slug is the stable identifier. Operator
 * edits via the form editor live alongside seeded content — we only
 * overwrite the row if the seeded draft has actually changed since the
 * last seed (compared by JSON.stringify equality on name + description +
 * titlePattern + variables + sections). That way a daemon restart
 * doesn't clobber operator tweaks; an explicit seed-side edit does.
 */
async function upsertSeededTemplate(db: Db, slug: string, draft: TaskTemplateDraft, now: number) {
  const existing = await db.select().from(taskTemplates).where(eq(taskTemplates.slug, slug)).get();
  const draftJson = JSON.stringify(draft);
  if (!existing) {
    await db.insert(taskTemplates).values({
      id: createId(),
      slug,
      name: draft.name,
      description: draft.description,
      draft: draftJson,
      sourcePlanId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`  + template ${slug}`);
    return;
  }
  if (existing.draft === draftJson) {
    console.log(`  · template ${slug} unchanged`);
    return;
  }
  // Operator edits: if the row's body differs from the seed AND the
  // updated_at is newer than the seed's intent, leave it alone. We use a
  // simple heuristic — if the operator changed the name or description,
  // they own the row now. Same-name same-description rows get re-seeded.
  const operatorEdited = existing.name !== draft.name || existing.description !== draft.description;
  if (operatorEdited) {
    console.log(`  · template ${slug} operator-edited; not overwritten`);
    return;
  }
  await db
    .update(taskTemplates)
    .set({
      name: draft.name,
      description: draft.description,
      draft: draftJson,
      updatedAt: now,
    })
    .where(eq(taskTemplates.slug, slug));
  console.log(`  ↻ template ${slug} refreshed from seed`);
}

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

  // Task templates: upsert each seeded template. Operator-edited rows are
  // preserved per the heuristic in upsertSeededTemplate.
  for (const t of SEEDED_TEMPLATES) {
    await upsertSeededTemplate(db, t.slug, t.draft, now);
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
