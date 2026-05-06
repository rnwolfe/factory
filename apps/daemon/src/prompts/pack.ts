import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq } from "drizzle-orm";
import YAML from "yaml";

const PACK_VERSION = 1;

interface PackVersion {
  version: number;
  body: string;
  createdAt: string;
}

interface PackEntry {
  key: string;
  activeVersion: number;
  versions: PackVersion[];
}

interface Pack {
  factoryPromptPack: number;
  exportedAt: string;
  factoryVersion?: string;
  prompts: PackEntry[];
}

export interface ApplyPackResult {
  perPrompt: Array<{
    key: string;
    added: number;
    skipped: number;
    activated: boolean;
  }>;
}

export class PackError extends Error {
  constructor(
    public readonly code: "bad_yaml" | "wrong_pack_version" | "missing_field" | "empty_pack",
    message: string,
  ) {
    super(message);
    this.name = "PackError";
  }
}

export function serializePack(db: Db, opts: { keys?: string[] } = {}): string {
  const distinctKeys =
    opts.keys && opts.keys.length > 0
      ? opts.keys
      : Array.from(
          new Set(
            db
              .select({ k: schema.prompts.promptKey })
              .from(schema.prompts)
              .all()
              .map((r) => r.k),
          ),
        ).sort();

  const entries: PackEntry[] = [];
  for (const key of distinctKeys) {
    const rows = db
      .select()
      .from(schema.prompts)
      .where(eq(schema.prompts.promptKey, key))
      .orderBy(schema.prompts.version)
      .all();
    if (rows.length === 0) continue;
    const active = rows.find((r) => r.active);
    if (!active) continue;
    entries.push({
      key,
      activeVersion: active.version,
      versions: rows.map((r) => ({
        version: r.version,
        body: r.content,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    });
  }

  const pack: Pack = {
    factoryPromptPack: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    prompts: entries,
  };
  return YAML.stringify(pack);
}

export function parsePack(yaml: string): Pack {
  let raw: unknown;
  try {
    raw = YAML.parse(yaml);
  } catch (err) {
    throw new PackError("bad_yaml", `failed to parse YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new PackError("bad_yaml", "pack must be a YAML mapping");
  }
  const r = raw as Record<string, unknown>;
  if (r.factoryPromptPack !== PACK_VERSION) {
    throw new PackError(
      "wrong_pack_version",
      `unsupported pack version: ${String(r.factoryPromptPack)}`,
    );
  }
  if (!Array.isArray(r.prompts)) {
    throw new PackError("missing_field", "pack.prompts must be an array");
  }
  const entries: PackEntry[] = [];
  for (const e of r.prompts) {
    if (!e || typeof e !== "object") {
      throw new PackError("missing_field", "each prompts entry must be a mapping");
    }
    const ee = e as Record<string, unknown>;
    if (typeof ee.key !== "string" || ee.key.length === 0) {
      throw new PackError("missing_field", "prompt entry missing key");
    }
    if (typeof ee.activeVersion !== "number") {
      throw new PackError("missing_field", `prompt ${ee.key} missing activeVersion`);
    }
    if (!Array.isArray(ee.versions) || ee.versions.length === 0) {
      throw new PackError("missing_field", `prompt ${ee.key} has no versions`);
    }
    const versions: PackVersion[] = [];
    for (const v of ee.versions) {
      if (!v || typeof v !== "object") {
        throw new PackError("missing_field", `prompt ${ee.key} version not a mapping`);
      }
      const vv = v as Record<string, unknown>;
      if (typeof vv.version !== "number" || typeof vv.body !== "string") {
        throw new PackError("missing_field", `prompt ${ee.key} version malformed`);
      }
      versions.push({
        version: vv.version,
        body: vv.body,
        createdAt: typeof vv.createdAt === "string" ? vv.createdAt : new Date().toISOString(),
      });
    }
    entries.push({
      key: ee.key,
      activeVersion: ee.activeVersion,
      versions,
    });
  }
  return {
    factoryPromptPack: PACK_VERSION,
    exportedAt: typeof r.exportedAt === "string" ? r.exportedAt : new Date().toISOString(),
    factoryVersion: typeof r.factoryVersion === "string" ? r.factoryVersion : undefined,
    prompts: entries,
  };
}

/**
 * Apply a parsed pack to the database. For each prompt key, insert any
 * versions not already present (matched by `(key, version)`). When
 * `activateImported` is true, flip the active row to the pack's
 * `activeVersion` (if that version exists locally after the merge).
 * When false (default), leave the destination's active row as-is — pure
 * additive import.
 */
export function applyPack(
  db: Db,
  pack: Pack,
  opts: { activateImported: boolean },
): ApplyPackResult {
  const perPrompt: ApplyPackResult["perPrompt"] = [];

  for (const entry of pack.prompts) {
    let added = 0;
    let skipped = 0;
    let activated = false;

    db.transaction((tx) => {
      const localRows = tx
        .select()
        .from(schema.prompts)
        .where(eq(schema.prompts.promptKey, entry.key))
        .all();
      const localByVersion = new Map(localRows.map((r) => [r.version, r]));

      for (const v of entry.versions) {
        if (localByVersion.has(v.version)) {
          skipped++;
          continue;
        }
        let createdAt = Date.now();
        const parsed = Date.parse(v.createdAt);
        if (!Number.isNaN(parsed)) createdAt = parsed;
        tx.insert(schema.prompts)
          .values({
            id: createId(),
            promptKey: entry.key,
            version: v.version,
            content: v.body,
            active: false,
            createdAt,
          })
          .run();
        added++;
      }

      if (opts.activateImported) {
        const target = tx
          .select()
          .from(schema.prompts)
          .where(
            and(
              eq(schema.prompts.promptKey, entry.key),
              eq(schema.prompts.version, entry.activeVersion),
            ),
          )
          .get();
        if (target && !target.active) {
          tx.update(schema.prompts)
            .set({ active: false })
            .where(and(eq(schema.prompts.promptKey, entry.key), eq(schema.prompts.active, true)))
            .run();
          tx.update(schema.prompts)
            .set({ active: true })
            .where(eq(schema.prompts.id, target.id))
            .run();
          activated = true;
        } else if (
          !tx
            .select()
            .from(schema.prompts)
            .where(and(eq(schema.prompts.promptKey, entry.key), eq(schema.prompts.active, true)))
            .get()
        ) {
          // No active row at all (fresh import) — activate the target.
          if (target) {
            tx.update(schema.prompts)
              .set({ active: true })
              .where(eq(schema.prompts.id, target.id))
              .run();
            activated = true;
          }
        }
      } else {
        // Additive: ensure exactly one active row exists for this key. If
        // local had none (fresh install of this key) the pack picks the
        // active version it carried.
        const localActive = tx
          .select()
          .from(schema.prompts)
          .where(and(eq(schema.prompts.promptKey, entry.key), eq(schema.prompts.active, true)))
          .get();
        if (!localActive) {
          const target = tx
            .select()
            .from(schema.prompts)
            .where(
              and(
                eq(schema.prompts.promptKey, entry.key),
                eq(schema.prompts.version, entry.activeVersion),
              ),
            )
            .get();
          if (target) {
            tx.update(schema.prompts)
              .set({ active: true })
              .where(eq(schema.prompts.id, target.id))
              .run();
            activated = true;
          } else {
            // Pack's activeVersion isn't in this entry — fall back to highest version present.
            const fallback = tx
              .select()
              .from(schema.prompts)
              .where(eq(schema.prompts.promptKey, entry.key))
              .orderBy(desc(schema.prompts.version))
              .limit(1)
              .get();
            if (fallback) {
              tx.update(schema.prompts)
                .set({ active: true })
                .where(eq(schema.prompts.id, fallback.id))
                .run();
              activated = true;
            }
          }
        }
      }
    });

    perPrompt.push({ key: entry.key, added, skipped, activated });
  }

  return { perPrompt };
}
