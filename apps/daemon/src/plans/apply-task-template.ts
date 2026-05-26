import { type Db, schema, type TaskTemplateDraft } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, isNull } from "drizzle-orm";

export interface ApplyTaskTemplateFreezeInput {
  db: Db;
  draft: TaskTemplateDraft;
  planId: string;
  /** Source-of-truth time. Tests can inject; defaults to `Date.now()`. */
  now?: number;
}

export interface ApplyTaskTemplateFreezeResult {
  /** New or updated task_templates row id. */
  templateId: string;
  slug: string;
  /** True when this freeze created a new row; false when it replaced an existing slug. */
  created: boolean;
}

/**
 * Persist a frozen `task_template` plan into the `task_templates` table.
 *
 * Slug collision is resolved by re-using the existing row's id (the
 * frozen plan supersedes the prior template version, same way frozen
 * project_vision plans supersede priors). The draft JSON is replaced
 * in-place and `updated_at` is bumped; the slug + id are stable so
 * downstream URL paths don't break.
 *
 * Soft-deletes (`archivedAt IS NOT NULL`) are reactivated when their
 * slug is re-frozen — the operator's intent is to bring the template
 * back; we don't want a frozen-after-archive freeze to silently produce
 * a hidden row.
 */
export async function applyTaskTemplateFreeze(
  input: ApplyTaskTemplateFreezeInput,
): Promise<ApplyTaskTemplateFreezeResult> {
  const { db, draft, planId } = input;
  if (draft.kind !== "task_template") {
    throw new Error(`applyTaskTemplateFreeze called with non-task_template draft: ${draft.kind}`);
  }
  if (!draft.name || draft.name.trim().length === 0) {
    throw new Error("task_template draft has no name — cannot freeze");
  }
  const now = input.now ?? Date.now();
  const slug = slugify(draft.name);

  const existing = await db
    .select()
    .from(schema.taskTemplates)
    .where(eq(schema.taskTemplates.slug, slug))
    .get();

  if (existing) {
    await db
      .update(schema.taskTemplates)
      .set({
        name: draft.name,
        description: draft.description,
        draft: JSON.stringify(draft),
        sourcePlanId: planId,
        archivedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.taskTemplates.id, existing.id));
    return { templateId: existing.id, slug, created: false };
  }

  const id = createId();
  await db.insert(schema.taskTemplates).values({
    id,
    slug,
    name: draft.name,
    description: draft.description,
    draft: JSON.stringify(draft),
    sourcePlanId: planId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { templateId: id, slug, created: true };
}

/**
 * Recover the seed draft when an operator opens "new template" in the inbox
 * — empty fields, sensible defaults for the priority/estimate enums so the
 * UI doesn't render an undefined chip on the first turn.
 */
export function seedTaskTemplateDraft(): TaskTemplateDraft {
  return {
    kind: "task_template",
    name: "",
    description: "",
    titlePattern: "",
    labels: [],
    priority: "med",
    estimate: "medium",
    variables: [],
    sections: [],
  };
}

/**
 * Fetch the latest frozen template draft for a given slug — used by the
 * instantiate path. Returns null when no row exists or the row is archived.
 */
export async function loadActiveTemplate(
  db: Db,
  slug: string,
): Promise<{ id: string; draft: TaskTemplateDraft } | null> {
  const row = await db
    .select()
    .from(schema.taskTemplates)
    .where(and(eq(schema.taskTemplates.slug, slug), isNull(schema.taskTemplates.archivedAt)))
    .orderBy(desc(schema.taskTemplates.updatedAt))
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.draft) as TaskTemplateDraft;
    if (parsed.kind !== "task_template") return null;
    return { id: row.id, draft: parsed };
  } catch {
    return null;
  }
}

const SLUG_CHARS = /[^a-z0-9-]+/g;

/** lowercased, hyphenated, trimmed; multi-hyphens collapsed. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(SLUG_CHARS, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}
