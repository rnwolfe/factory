import YAML from "yaml";

export class RubricValidationError extends Error {
  constructor(
    public readonly code: "bad_yaml" | "missing_field" | "wrong_shape",
    message: string,
  ) {
    super(message);
    this.name = "RubricValidationError";
  }
}

export interface ParsedRubric {
  id?: string;
  version?: number;
  axes: Array<{ id: string; weight: number; prompt: string }>;
  outcomes?: Record<string, unknown>;
  promptKey?: string;
}

/**
 * Parse + shape-check a rubric YAML body. Returns a typed view if valid;
 * throws RubricValidationError otherwise. The shape check is deliberately
 * loose — we only enforce the bits the runtime relies on (axes with id /
 * weight / prompt). Operators get to evolve the rest.
 */
export function validateRubricYaml(yaml: string): ParsedRubric {
  let raw: unknown;
  try {
    raw = YAML.parse(yaml);
  } catch (err) {
    throw new RubricValidationError("bad_yaml", `failed to parse YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RubricValidationError("wrong_shape", "rubric must be a YAML mapping");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.axes) || r.axes.length === 0) {
    throw new RubricValidationError("missing_field", "rubric must define a non-empty `axes` array");
  }
  const axes: ParsedRubric["axes"] = [];
  for (const a of r.axes) {
    if (!a || typeof a !== "object") {
      throw new RubricValidationError("wrong_shape", "each axis must be a mapping");
    }
    const aa = a as Record<string, unknown>;
    if (typeof aa.id !== "string" || aa.id.length === 0) {
      throw new RubricValidationError("missing_field", "axis missing string `id`");
    }
    if (typeof aa.weight !== "number") {
      throw new RubricValidationError("missing_field", `axis ${aa.id} missing numeric \`weight\``);
    }
    if (typeof aa.prompt !== "string" || aa.prompt.length === 0) {
      throw new RubricValidationError("missing_field", `axis ${aa.id} missing string \`prompt\``);
    }
    axes.push({ id: aa.id, weight: aa.weight, prompt: aa.prompt });
  }
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    version: typeof r.version === "number" ? r.version : undefined,
    axes,
    outcomes: r.outcomes as Record<string, unknown> | undefined,
    promptKey:
      typeof (r.agent_invocation as Record<string, unknown> | undefined)?.prompt_key === "string"
        ? ((r.agent_invocation as Record<string, unknown>).prompt_key as string)
        : undefined,
  };
}
