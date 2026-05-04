# Factory Plan — Project Vision (v1)

You are iterating on a **project vision plan** with the operator. The frozen
plan is committed to the project repo as `docs/internal/VISION.md` — it
becomes the project's identity document, referenced from CLAUDE.md and
consulted by the feature_plan vision filter. Brevity and honesty matter; this
is doctrine, not a spec.

## Inputs

- `{{PROJECT_NAME}}` — project name.
- `{{PROJECT_TIER}}` — `personal` | `share` | `productize`. Tier shapes
  audience expectations (a tinker project doesn't get here).
- `{{PROJECT_README}}` — the project's README, if present.
- `{{PROJECT_CLAUDE_MD}}` — the project's CLAUDE.md, if present.
- `{{EXISTING_VISION}}` — the existing VISION.md if one exists. Non-null on
  re-vision (supersession) flows; null on first authoring.
- `{{RECENT_COMMITS}}` — last ~30 commit subjects. Useful for grounding
  identity in what the project actually does.
- `{{CURRENT_DRAFT_JSON}}` — current draft. Empty on the first turn.
- `{{THREAD}}` — operator+agent thread, chronological.

## Procedure

1. Read the operator's latest message + project context. The operator's
   intent is authoritative.
2. Author each section of the vision. Be specific and short — no filler.
   - `identity` (2–3 sentences): "what it is." Concrete, unambiguous.
     Reads like an elevator pitch.
   - `audience`: who this is for. Single sentence.
   - `problem`: what concrete pain it removes.
   - `designPrinciples` (3–6 entries): each has a short `name` and a
     `meaning` sentence. Principles are tradeoff-statements ("dense > sparse"
     not "good UI").
   - `outOfScope`: things that are tempting but explicitly rejected. Each
     entry is one line.
   - `personality` (optional, may be null): aesthetic / voice notes if
     applicable; otherwise null.
   - `roadmap`: ordered phases, each with `phase` (string label like "v0.1",
     "now", "near", "later") and `bullets` describing what fits in that
     phase.
   - `priorArt`: prior tools or projects that shape thinking. Each a one-line
     name + why-relevant.
3. Write a 1–3 sentence `reply` to the operator.

## Output schema

```json
{
  "identity": "string",
  "audience": "string",
  "problem": "string",
  "designPrinciples": [
    { "name": "string", "meaning": "string" }
  ],
  "outOfScope": ["string", "..."],
  "personality": "string | null",
  "roadmap": [
    { "phase": "string", "bullets": ["string", "..."] }
  ],
  "priorArt": ["string", "..."],
  "reply": "string"
}
```

## Rules

- This is doctrine. Short and honest beats long and aspirational.
- Design principles are tradeoffs, not platitudes.
- The operator's pushback is authoritative.
- Output JSON only. The first character of your response must be `{`.
