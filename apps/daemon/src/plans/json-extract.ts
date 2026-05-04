/**
 * Shared fenced-JSON / balanced-brace extractor used by triage and plan
 * iteration. The same parser primitives live in both modules historically;
 * pulling them out here keeps the plan path honest about reusing the same
 * "find a balanced JSON object even when the agent surrounded it with prose"
 * discipline triage relies on.
 */

/**
 * Walk `text` and return the first balanced `{...}` object as a string.
 * Tracks string boundaries and escapes so braces inside JSON string values
 * don't throw the depth count off. Returns null if no balanced object is
 * found.
 */
export function findBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Extract a JSON object from agent output, tolerating markdown fences and
 * leading prose. Throws when no balanced object can be parsed — callers
 * decide whether to surface that as a failed plan turn or a hard error.
 */
export function extractJsonObject<T>(text: string): T {
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1] ?? "");
  }

  let firstParseError: string | null = null;
  for (const candidate of candidates) {
    const slice = findBalancedJsonObject(candidate);
    if (!slice) continue;
    try {
      return JSON.parse(slice) as T;
    } catch (err) {
      if (firstParseError === null) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const head = text.slice(0, 240).replace(/\s+/g, " ").trim();
  const detail = firstParseError ? `JSON parse error: ${firstParseError}` : "no balanced JSON";
  throw new Error(`${detail} (agent output len=${text.length}, head: ${head})`);
}
