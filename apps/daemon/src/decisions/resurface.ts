import type { EventBus } from "../events.ts";
import { createTask, type TaskFile, type TaskTarget } from "../projects/tasks.ts";

/**
 * How the operator resolved an `agent_decision`. The agent makes a call
 * mid-run and proceeds; when it lands in the inbox the operator either
 * **ratifies** it (accepts the agent's proposed answer verbatim) or
 * **overrides** it — picks a different option, changes the selected subset,
 * or writes a custom answer. This union is the override shape.
 *
 * Ratification routes through `decisions.action` (approve) and never produces
 * one of these. Every override produces exactly one.
 */
export type AgentDecisionOverride =
  | { kind: "single"; choice: string }
  | { kind: "multi"; choices: string[] }
  | { kind: "custom"; text: string };

/**
 * Flatten an override to the single human-readable answer the operator asked
 * for. The resurfacing seam (task-062), the GitHub follow-up issue (task-063),
 * and the inbox/board (task-064) all need this string; deriving it in one
 * place keeps them consistent.
 */
export function resurfaceAnswer(override: AgentDecisionOverride): string {
  switch (override.kind) {
    case "single":
      return override.choice;
    case "multi":
      return override.choices.join(", ");
    case "custom":
      return override.text;
  }
}

/**
 * Everything the resurfacing seam needs to re-queue overridden work and keep
 * the audit trail back to the originating decision. task-061 emits this; the
 * backend-agnostic seam (task-062) and the per-backend re-queue (local-file /
 * GitHub-Issue, tasks 062/063) consume it.
 */
export interface ResurfaceSignal {
  decisionId: string;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  /** The agent's original proposed answer, for the audit trail. */
  agentDecided: string | null;
  /** The operator's chosen/custom answer that must now be implemented. */
  answer: string;
  /** The raw override, so consumers can branch on single/multi/custom. */
  override: AgentDecisionOverride;
  at: number;
}

/**
 * Announce that an adjusted (non-ratified) `agent_decision` must resurface for
 * implementation rather than silently closing.
 *
 * This is the single point where a non-ratification turns into a resurfacing
 * signal (task-061). Detection is purely the operator's ratify-vs-override
 * choice: ratify never reaches this function; every override does. **No agent
 * judgement of materiality is involved** — the trigger is solely which path
 * the operator took.
 *
 * task-061 emits the signal as an inbox event so live surfaces can react.
 * task-062 will grow this seam to re-queue a concrete unit of work across the
 * local-file and GitHub-Issue task backends; the persisted `override` /
 * `overrideAt` on the decision payload is the queryable marker those consumers
 * key on.
 */
export function emitResurfaceSignal(events: EventBus, signal: ResurfaceSignal): void {
  events.publish({
    channel: "inbox",
    kind: "decision_resurfaced",
    decisionId: signal.decisionId,
    projectId: signal.projectId,
  });
}

/** Everything `resurfaceWorkForDecision` needs to author the re-queued unit. */
export interface ResurfaceWorkInput {
  decisionId: string;
  /** Headline of the original decision — drives the re-queued unit's title. */
  summary: string | null;
  /** The agent's original proposed answer, for the audit trail. */
  agentDecided: string | null;
  /** The operator's chosen/custom answer that must now be implemented. */
  answer: string;
  /** The original task the decision came from, if any — linked as `parent`. */
  originalTaskId: string | null;
  /** The run the decision was raised in, if any — named for traceability. */
  runId: string | null;
  /** The options the agent weighed, surfaced in the body for context. */
  options?: Array<{ title: string }>;
}

/** Render the markdown body of a resurfaced unit of work. */
function renderResurfaceBody(input: ResurfaceWorkInput): string {
  const agentChose = input.agentDecided ?? "(unspecified)";
  const optionsLine =
    input.options && input.options.length > 0
      ? `\nThe agent weighed: ${input.options.map((o) => `\`${o.title}\``).join(", ")}.`
      : "";
  const provenance = [
    `- Originating decision: \`${input.decisionId}\``,
    input.originalTaskId ? `- Original task: \`${input.originalTaskId}\`` : null,
    input.runId ? `- Source run: \`${input.runId}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "## Context",
    "",
    "This work resurfaced from an operator override of an agent decision. The",
    "agent made a call mid-run and the operator did not ratify it — the override",
    "must be implemented rather than silently closed.",
    "",
    `**Agent decided:** ${agentChose}`,
    `**Operator requires:** ${input.answer}${optionsLine}`,
    "",
    "## Acceptance",
    "",
    `- [ ] The implementation reflects the operator's answer: ${input.answer}`,
    "- [ ] Any work that assumed the agent's original answer is reconciled.",
    "",
    "## Provenance",
    "",
    provenance,
  ].join("\n");
}

/**
 * Re-queue overridden work through the task-store seam (`TaskStore.create`),
 * the single point both the local-file and GitHub-Issue backends implement.
 * `createTask` dispatches to whichever backend the target uses, so a non-GitHub
 * project gets a `.factory/work` task and a GitHub project gets a follow-up
 * issue — both from this one call.
 *
 * The resulting unit of work carries `sourceDecisionId` (the audit link back to
 * the originating decision) and the operator's answer in its body, so a future
 * run implements the operator's preference. Returns the created task.
 */
export function resurfaceWorkForDecision(
  target: TaskTarget,
  input: ResurfaceWorkInput,
): Promise<TaskFile> {
  const title = `Implement override: ${input.summary ?? "agent decision"}`.slice(0, 120);
  return createTask(target, {
    title,
    body: renderResurfaceBody(input),
    status: "ready",
    labels: ["resurfaced"],
    parent: input.originalTaskId ?? undefined,
    sourceDecisionId: input.decisionId,
  });
}
