import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { EventBus } from "../events.ts";
import type { PersistedObservation } from "./observation-store.ts";
import type { ObservationEvidence } from "./synthesize.ts";

/**
 * Surface newly-persisted observations into the decisions inbox as
 * `watch_insight` decisions (ADR-010 §3/§5). Notify-grade, never blocking; the
 * operator adopts (→ task), acknowledges, or dismisses from the inbox. The
 * observation row's status flips `pending → surfaced` so it isn't re-surfaced.
 */

/** The `decisions.payload` shape for a `watch_insight` decision. */
export interface WatchInsightPayload {
  observationId: string;
  observationKind: PersistedObservation["kind"];
  title: string;
  detail: string;
  proposal: PersistedObservation["proposal"];
  evidence: ObservationEvidence[];
  /** Slug the insight maps to, or null for an operator-level (cross-project) one. */
  targetProjectSlug: string | null;
  /** The specific task to act on (groom-backlog promotion), or null. */
  targetTaskId?: string | null;
}

/**
 * Compose the body of a skill-authoring task from a Watch insight (ADR-024). The
 * task lands on the designated skills-registry project; a normal Factory run then
 * authors an `npx skills`-compatible `SKILL.md`. This is the actionable outcome
 * for a project-less insight — "good idea, make this a reusable skill" — turned
 * into real, harness-agnostic work rather than a bare acknowledge.
 */
export function renderSkillBrief(payload: WatchInsightPayload, directive?: string | null): string {
  const sessions = payload.evidence
    .map((e) => `${e.sourceId}/${e.sessionId.slice(0, 8)}`)
    .join(", ");
  const provenance = sessions
    ? `observed across ${payload.evidence.length} out-of-band session(s): ${sessions}`
    : "synthesized by The Watch";
  const directiveBlock = directive?.trim() ? `\n**Operator directive:** ${directive.trim()}\n` : "";
  return `Author a new, reusable **agent skill** in this registry from a recurring ritual The
Watch noticed. Follow \`AGENTS.md\` for the conventions.

## The ritual
${payload.detail}
${directiveBlock}
## What to build
Create \`skills/<kebab-name>/SKILL.md\` where \`<kebab-name>\` reads as the capability:

- **Frontmatter** — \`name\` (matching the dir) and a \`description\` written as a *trigger*:
  what it does AND when to use it, in the third person, with the concrete phrasings the
  operator would type next time. Not a summary.
- **Body** — the actual repeatable procedure, written **harness-agnostically** (no reliance
  on a specific agent's tool names, slash commands, or config paths) so the one \`SKILL.md\`
  installs cleanly across Claude Code, Codex, Cursor, OpenCode, etc. Keep it lean; push long
  references/templates into \`reference/\` files.
- **Provenance** — record that this skill originated from a Watch insight (${provenance})
  in a trailing note or \`reference/origin.md\`.

## Acceptance
- \`skills/<name>/SKILL.md\` exists with valid frontmatter (\`name\`, \`description\`).
- The description names concrete trigger situations, not just a summary.
- The body is harness-agnostic and captures the *repeatable* ritual, not a one-off.
- Installable via \`npx skills add rnwolfe/skills --skill <name>\`.

_From The Watch — ${provenance}._`;
}

export function surfaceObservations(
  db: Db,
  events: EventBus,
  observations: PersistedObservation[],
): void {
  const now = Date.now();
  for (const o of observations) {
    // Resolve slug → projectId; operator-level insights have neither.
    let projectId: string | null = null;
    if (o.targetProjectSlug) {
      const project = db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.slug, o.targetProjectSlug))
        .get();
      projectId = project?.id ?? null;
    }

    const decisionId = createId();
    const payload: WatchInsightPayload = {
      observationId: o.id,
      observationKind: o.kind,
      title: o.title,
      detail: o.detail,
      proposal: o.proposal,
      evidence: o.evidence,
      targetProjectSlug: o.targetProjectSlug,
      targetTaskId: o.targetTaskId ?? null,
    };
    db.insert(schema.decisions)
      .values({
        id: decisionId,
        kind: "watch_insight",
        projectId,
        outcome: "watch_insight",
        payload,
        status: "pending",
        createdAt: now,
      })
      .run();
    db.update(schema.watchObservations)
      .set({ status: "surfaced", updatedAt: now })
      .where(eq(schema.watchObservations.id, o.id))
      .run();
    events.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId,
      projectId: projectId ?? undefined,
    });
  }
}
