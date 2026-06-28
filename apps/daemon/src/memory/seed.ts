import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import { listHarnessSources } from "../watch/sources/registry.ts";
import type { MemoryDoc } from "../watch/sources/types.ts";
import {
  type MemoryFactInput,
  type MemoryFactType,
  slugify,
  writeMemoryFact,
} from "./operator-memory.ts";

/**
 * Seed the operator-memory repo by SYNTHESIZING from the harness memories the
 * operator already maintains (ADR-010 §4, operator-chosen route). Fresh, not a
 * mirror: the model distills cross-harness conventions/preferences into a deduped
 * set of operator-memory facts — it does NOT copy memory docs verbatim. Token-heavy
 * → invoked only on an explicit settings trigger, never on boot.
 *
 * The LLM call is injectable so the parse/validate/write logic is testable without
 * spawning a CLI — same discipline as the synthesizer.
 */

export type InvokeFn = (prompt: string) => Promise<string>;
const FACT_TYPES = new Set<MemoryFactType>(["user", "feedback", "project", "reference"]);

export interface SeedDeps {
  invoke?: InvokeFn;
  budgetSeconds?: number;
  /** Test seam: inject memory docs instead of reading the real harness sources. */
  memories?: MemoryDoc[];
}

export interface SeedResult {
  /** Harness memory docs fed to synthesis. */
  memoriesRead: number;
  /** Source ids that contributed memories. */
  sources: string[];
  /** Operator-memory facts written. */
  factsWritten: number;
}

export async function seedOperatorMemory(
  repoPath: string,
  deps: SeedDeps = {},
): Promise<SeedResult> {
  const memories: MemoryDoc[] = [];
  const sources: string[] = [];
  if (deps.memories) {
    memories.push(...deps.memories);
    for (const m of deps.memories) if (!sources.includes(m.sourceId)) sources.push(m.sourceId);
  } else {
    for (const s of listHarnessSources()) {
      if (!(await s.isAvailable())) continue;
      const docs = await s.readMemories();
      if (docs.length > 0) {
        memories.push(...docs);
        sources.push(s.id);
      }
    }
  }
  if (memories.length === 0) return { memoriesRead: 0, sources: [], factsWritten: 0 };

  const invoke = deps.invoke ?? defaultInvoke(deps.budgetSeconds ?? 0);
  const text = await invoke(buildSeedPrompt(memories));
  // Throws when nothing parseable — the honest null-parse-fail contract.
  const parsed = extractJsonObject<{ facts?: unknown }>(text);
  const facts = validateFacts(parsed.facts);

  let written = 0;
  for (const fact of facts) {
    await writeMemoryFact(repoPath, fact);
    written += 1;
  }
  return { memoriesRead: memories.length, sources, factsWritten: written };
}

function defaultInvoke(budgetSeconds: number): InvokeFn {
  return async (prompt) => {
    const { text } = await invokeClaudeJson(prompt, { budgetSeconds, agent: "claude-code" });
    return text;
  };
}

export function buildSeedPrompt(memories: MemoryDoc[]): string {
  const block = memories
    .map((m) => `### [${m.sourceId}] ${m.title}\n${m.body.trim().slice(0, 2000)}`)
    .join("\n\n");

  return `You are seeding Heimdall's operator-memory — a Factory-earned memory of how THIS
operator works, distilled from the memory files they already keep across harnesses
(Claude Code, Codex, …).

You are given those existing memory docs below. SYNTHESIZE them into a small, deduped
set of durable operator-memory facts — the operator's conventions, preferences, working
patterns, and standing constraints. This is synthesis, NOT copying:
- Merge overlapping notes across harnesses into one fact; drop one-off/ephemeral items.
- Generalize to durable preference ("prefers X for Y because Z"), not transient task state.
- Prefer FEW strong, high-signal facts over many weak ones. Skip project-specific minutiae
  unless it reflects a cross-project habit.
- Never invent preferences not supported by the docs.

EXISTING HARNESS MEMORY:
${block}

Respond with ONE fenced \`\`\`json block, no prose, matching exactly:
{
  "facts": [
    {
      "name": "<kebab-case slug, ≤64 chars>",
      "description": "<one-line summary, used in the index>",
      "type": "user" | "feedback" | "project" | "reference",
      "body": "<1-4 sentences: the durable fact, with the why where it matters>"
    }
  ]
}

Type guidance: "user" = who they are / hard preferences; "feedback" = how they want work
done (conventions, corrections); "project" = a cross-project working pattern; "reference"
= a pointer to a resource. Default to "feedback" for a working convention.`;
}

function validateFacts(raw: unknown): MemoryFactInput[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryFactInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const description = typeof o.description === "string" ? o.description.trim() : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!description || !body) continue;
    const rawType = String(o.type ?? "");
    const type = (FACT_TYPES as Set<string>).has(rawType)
      ? (rawType as MemoryFactType)
      : "feedback";
    const name = slugify(typeof o.name === "string" && o.name.trim() ? o.name : description);
    if (seen.has(name)) continue; // de-dupe slug collisions
    seen.add(name);
    out.push({ name, description, type, body });
  }
  return out;
}
