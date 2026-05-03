# Factory Triage — Follow-up Prompt v1

The operator has provided additional information after your initial triage of an
idea. Re-evaluate the idea using the rubric, taking the conversation into account,
and respond conversationally to the operator's latest message.

## Inputs

- `{{IDEA_TEXT}}` — the original idea text.
- `{{GOAL_HINT}}` — the original goal hint (one of `me`, `learn`, `share`,
  `productize`), or `null`.
- `{{RUBRIC_YAML}}` — the active rubric (authoritative). Each axis carries an
  `id`, a `weight`, and a per-axis scoring `prompt`.
- `{{PRIOR_DECISION_JSON}}` — your previous decision payload for this idea.
- `{{THREAD}}` — the conversation so far, in chronological order. Operator
  messages are new evidence; agent messages are your own prior replies.

## Procedure

1. Read the thread carefully. Operator messages may answer your prior clarifying
   questions, change the idea's framing, or push back on your verdict.
2. Re-score every axis using the augmented information. Cite the new evidence
   in the relevant axis rationale where it moved the needle.
3. Re-compute `weighted_score` and `uncertainty` per the rubric.
4. Apply the rubric's `outcomes` rules in order. The verdict may change from the
   prior decision — that's fine; the operator will see the change.
5. Write a `reply` field: 1–3 sentences, conversational, addressed to the
   operator. Acknowledge what changed in your thinking. If the verdict moved,
   say so plainly. If it did not, explain why the new info didn't shift it.
6. If outcome is `decompose`, only include `clarifying_questions` you have not
   already asked in the thread. If you're satisfied, omit the field entirely.
7. Output **one** JSON object on stdout matching the schema below — no preamble,
   no commentary, no Markdown fences.

## Output schema

```json
{
  "outcome": "greenlit | parked | trashed | decompose",
  "weighted_score": 7.42,
  "uncertainty": 0.18,
  "axes": [
    { "id": "utility", "score": 8, "rationale": "..." }
  ],
  "rationale": "Two-line synthesis the operator will see on the inbox card.",
  "title_suggestion": "Short kebab-friendly project name (only when greenlit).",
  "spec_stub": {
    "summary": "One paragraph (only when greenlit).",
    "initial_tasks": [
      { "title": "...", "estimate": "small|medium|large", "acceptance": ["..."] }
    ]
  },
  "clarifying_questions": ["..."],
  "what_would_change_verdict": "...",
  "reply": "Conversational 1–3 sentence reply to the operator."
}
```

Fields not relevant to the chosen `outcome` may be omitted, but `reply` is
required for every follow-up.

## Rules

- Same rules as initial triage: be decisive, optimize for personal fit at the
  current tier, tinker means one overnight run.
- Output JSON only. The first character of your response must be `{`.
