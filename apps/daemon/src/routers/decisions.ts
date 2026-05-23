import { schema } from "@factory/db";
import { mergeIntoMain } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { seedProjectSpecDraft, seedRefinementDraft } from "../plans/iterate.ts";
import { runFollowupTriage, type TriageDecisionPayload } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { submitRun } from "../workers/submit.ts";

interface BlockedRunPayload {
  runId: string;
  taskId?: string | null;
  summary?: string;
  questions?: string[];
  branch?: string;
  /**
   * Set when the blocked_run decision was raised because the run hit a
   * usage cap (rather than the agent blocking on a question). Approving it
   * resumes the capped run's Claude session via `reuseFromRunId` instead of
   * branching a fresh run off the branch tip.
   */
  usageCapped?: boolean;
  /**
   * Set when the source run terminated as `failed` (rather than the agent
   * self-declaring `blocked`). Same retry mechanics — approve still branches
   * a new worktree from the source run's tip — but the operator-facing copy
   * frames it as "run failed, retry" instead of "agent blocked, answer".
   */
  failed?: boolean;
}

interface MergeFailurePayload {
  runId: string;
  taskId?: string | null;
  branch: string;
  reason: string;
  message: string;
  summary?: string;
}

const ActionEnum = z.enum(["approve", "park", "trash", "decompose", "dismiss"]);

const OverrideShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single"), choice: z.string().min(1).max(240) }),
  z.object({
    kind: z.literal("multi"),
    choices: z.array(z.string().min(1).max(240)).min(1).max(10),
  }),
  z.object({ kind: z.literal("custom"), text: z.string().min(1).max(2000) }),
]);

/**
 * Render the operator-context payload threaded into a blocked-run retry.
 * Quotes the agent's prior questions back at it (so the agent sees what
 * was asked even if its session context is cold) and inlines the operator
 * thread in chronological order. Empty-string return signals "no operator
 * input — submit the retry without a context block" so the runner falls
 * back to the original prompt.
 */
function renderBlockedRunOperatorContext(
  payload: BlockedRunPayload,
  thread: Array<{ role: "operator" | "agent"; body: string; createdAt: number }>,
): string {
  const operatorReplies = thread.filter((c) => c.role === "operator");
  if (operatorReplies.length === 0) return "";

  const header = `## Operator notes (from prior blocked run)

The operator replied to your prior run's blocking questions. Treat this as
authoritative — these answers are the resolution for the blocker. If they
contradict the task body, the operator's notes are the more recent intent.`;

  const questionsBlock =
    payload.questions && payload.questions.length > 0
      ? `### Questions you asked\n\n${payload.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n`
      : "";

  const repliesBlock = operatorReplies
    .map((c) => `### Operator reply · ${new Date(c.createdAt).toISOString()}\n\n${c.body.trim()}`)
    .join("\n\n");

  return `${header}\n\n${questionsBlock}${repliesBlock}`;
}

function renderOverrideComment(
  payload: AgentDecisionPayloadShape,
  override:
    | { kind: "single"; choice: string }
    | { kind: "multi"; choices: string[] }
    | { kind: "custom"; text: string },
): string {
  const headline = payload.summary ?? "agent decision";
  const agentChose = payload.decided ?? "(unspecified)";
  const operatorChose =
    override.kind === "single"
      ? override.choice
      : override.kind === "multi"
        ? override.choices.join(", ")
        : override.text;
  const optionsSummary =
    payload.options && payload.options.length > 0
      ? `\n\nThe agent considered: ${payload.options.map((o) => `\`${o.title}\``).join(", ")}.`
      : "";
  return [
    `Operator override on ${payload.id ?? "agent decision"} — ${headline}`,
    "",
    `**Agent decided:** ${agentChose}`,
    `**Operator prefers:** ${operatorChose}${optionsSummary}`,
    "",
    "Please update this task's acceptance / scope to reflect the operator's preference. If the original work needs to be redone, surface that in your refinement reply.",
  ].join("\n");
}

interface AgentDecisionPayloadShape {
  id?: string;
  kind?: string;
  responseType?: string;
  summary?: string;
  decided?: string;
  options?: Array<{ title: string; tradeoff?: string; chosen?: boolean }>;
  runId?: string;
  taskId?: string | null;
  /** Set by the override mutation when an operator pushes back. */
  override?:
    | { kind: "single"; choice: string }
    | { kind: "multi"; choices: string[] }
    | { kind: "custom"; text: string };
  overrideAt?: number;
}

export const decisionsRouter = router({
  inbox: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.status, "pending"))
      .orderBy(desc(schema.decisions.createdAt))
      .all();
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(50) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.decisions)
        .where(ne(schema.decisions.status, "pending"))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(input.limit)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return (
      ctx.db.select().from(schema.decisions).where(eq(schema.decisions.id, input.id)).get() ?? null
    );
  }),

  action: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        action: ActionEnum,
        note: z.string().optional(),
        /** Claude model id for the project's runs. Approve-only; ignored otherwise. */
        model: z.string().nullable().optional(),
        /** Ceremony level carried into the project_spec plan and on into bootstrap. */
        ceremony: z.enum(["tinker", "personal", "shared", "production"]).optional(),
        /** Owner vs contributor — determines whether bootstrap creates a vision plan. */
        role: z.enum(["owner", "contributor"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.status !== "pending") {
        throw new Error(`decision already ${decision.status}`);
      }

      let projectId: string | null = null;
      let retryRunId: string | null = null;
      let mergedSha: string | null = null;
      let planId: string | null = null;

      if (input.action === "approve" && decision.kind === "merge_failure") {
        // Retry the merge of the run's branch into main. If main is still
        // dirty (the original failure mode) the operator gets a clear error
        // and the decision stays pending — they can clean up and approve
        // again. Success closes the decision.
        const payload = decision.payload as MergeFailurePayload;
        if (!decision.projectId) throw new Error("merge_failure decision missing projectId");
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, decision.projectId))
          .get();
        if (!project) throw new Error("project not found");
        const taskLabel = payload.taskId ?? "ad-hoc";
        const merge = await mergeIntoMain({
          projectPath: project.workdirPath,
          branch: payload.branch,
          message: `chore: merge ${taskLabel} · run ${payload.runId.slice(0, 8)} (retry)`,
          author: ctx.config.gitAuthor,
        });
        if (!merge.ok) {
          throw new Error(`merge still failing — ${merge.reason}: ${merge.message}`);
        }
        mergedSha = merge.sha;
        projectId = project.id;
        if (!merge.alreadyMerged) {
          ctx.events.publish({
            channel: "events",
            kind: "commit",
            runId: payload.runId,
            iteration: 1,
            sha: merge.sha,
            subject: `merge to main: ${payload.branch}`,
          });
        }
      }

      if (input.action === "approve" && decision.kind === "blocked_run") {
        // "approve" on a blocked-run decision means retry. Submit a new run
        // whose worktree is based on the source run's branch tip — partial
        // work and the source run's auto-commit ride forward.
        const payload = decision.payload as BlockedRunPayload;
        const source = await ctx.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, payload.runId))
          .get();
        if (!source) throw new Error("source run not found");

        // Gather operator answers from the decision thread and fold them
        // into the new run's prompt. Without this, the retry re-runs with
        // the same task body and the agent re-hits its prior blocker.
        const thread = await ctx.db
          .select()
          .from(schema.decisionComments)
          .where(eq(schema.decisionComments.decisionId, decision.id))
          .orderBy(asc(schema.decisionComments.createdAt))
          .all();
        const operatorContext = renderBlockedRunOperatorContext(payload, thread);

        const result = await submitRun(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          payload.usageCapped
            ? {
                // Usage-cap resume: reuse the capped run's worktree + Claude
                // session so the agent continues from where the quota cut it
                // off, rather than re-deriving context on a fresh run.
                projectId: source.projectId,
                taskId: source.taskId ?? undefined,
                reuseFromRunId: payload.runId,
                operatorContext,
              }
            : {
                projectId: source.projectId,
                taskId: source.taskId ?? undefined,
                baseRef: source.branch,
                operatorContext,
              },
        );
        retryRunId = result.runId;
        projectId = source.projectId;
      }

      if (input.action === "approve" && decision.kind === "triage") {
        if (!decision.ideaId) throw new Error("triage decision missing ideaId");

        // Contributor-intent ideas need an upstream repo, which Factory's
        // triage payload doesn't carry. Approving here would fresh-init a
        // repo that defeats the purpose; the operator should use the
        // import flow (clone the upstream, then earmark it as a
        // contributor project there). Refuse with a clear redirect.
        const idea = await ctx.db
          .select()
          .from(schema.ideas)
          .where(eq(schema.ideas.id, decision.ideaId))
          .get();
        if (idea?.intentRole === "contributor") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "contributor-intent ideas can't bootstrap a fresh project — import the upstream repo via /projects/import, then operate on it from there",
          });
        }

        // v0.2: route triage approval through a project_spec foundry plan
        // instead of bootstrapping immediately. The decision is marked
        // actioned (the approval happened); the project materializes when
        // the operator freezes the plan.
        const existing = await ctx.db
          .select()
          .from(schema.plans)
          .where(
            and(eq(schema.plans.decisionId, decision.id), eq(schema.plans.kind, "project_spec")),
          )
          .get();
        if (existing) {
          planId = existing.id;
        } else {
          const payload = decision.payload as TriageDecisionPayload;
          const seed = seedProjectSpecDraft(payload);
          const id = createId();
          const tnow = Date.now();
          const goalText =
            payload.title_suggestion ??
            payload.spec_stub?.summary?.slice(0, 120) ??
            "Refine project spec";
          await ctx.db.insert(schema.plans).values({
            id,
            kind: "project_spec",
            status: "drafting",
            decisionId: decision.id,
            goal: goalText,
            draft: JSON.stringify(seed),
            ceremony: input.ceremony ?? null,
            createdAt: tnow,
            updatedAt: tnow,
          });
          planId = id;
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_created",
            planId: id,
            planKind: "project_spec",
          });
        }
      }

      const now = Date.now();
      await ctx.db
        .update(schema.decisions)
        .set({
          status: input.action === "dismiss" ? "dismissed" : "actioned",
          actionedAt: now,
          ...(projectId ? { projectId } : {}),
        })
        .where(eq(schema.decisions.id, input.decisionId));

      ctx.events.publish({
        channel: "inbox",
        kind: "decision_actioned",
        decisionId: input.decisionId,
      });

      return { ok: true, projectId, retryRunId, mergedSha, planId };
    }),

  /**
   * Override an `agent_decision` — operator picks a different option (or
   * subset, or types a custom answer) than what the agent decided.
   *
   * The decision row is marked actioned with the operator's choice
   * appended to the payload (so the audit trail stays uniform), and a
   * refinement plan is created against the source task seeded with a
   * comment that names the override. The operator iterates the
   * refinement to either rewrite acceptance or spawn follow-up tasks
   * that bake in their preference.
   *
   * Ad-hoc runs (no taskId) can be overridden but skip the refinement
   * plan creation — the operator's preference is captured on the
   * decision row only. They can still see it in history.
   */
  overrideAgentDecision: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        override: OverrideShape,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.kind !== "agent_decision") {
        throw new Error(`overrideAgentDecision only handles agent_decision (got ${decision.kind})`);
      }
      if (decision.status !== "pending") {
        throw new Error(`decision already ${decision.status}`);
      }

      const payload = (decision.payload ?? {}) as AgentDecisionPayloadShape;
      const projectId = decision.projectId;
      const taskId = payload.taskId ?? null;
      const now = Date.now();

      // Persist the override on the decision payload. We keep the original
      // agent payload intact and add `override` + `overrideAt` so the audit
      // trail shows what the agent picked AND what the operator preferred.
      const newPayload: AgentDecisionPayloadShape = {
        ...payload,
        override: input.override,
        overrideAt: now,
      };
      await ctx.db
        .update(schema.decisions)
        .set({ payload: newPayload, status: "actioned", actionedAt: now })
        .where(eq(schema.decisions.id, input.decisionId));

      ctx.events.publish({
        channel: "inbox",
        kind: "decision_actioned",
        decisionId: input.decisionId,
        projectId: projectId ?? null,
      });

      let planId: string | null = null;

      // Open a refinement plan when there's a task to refine. The plan is
      // seeded with an operator comment naming the override, so the
      // agent's first iteration on the refinement has the context.
      if (projectId && taskId) {
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get();
        if (project) {
          const existingPlan = await ctx.db
            .select()
            .from(schema.plans)
            .where(
              and(
                eq(schema.plans.projectId, projectId),
                eq(schema.plans.taskId, taskId),
                eq(schema.plans.kind, "refinement"),
                eq(schema.plans.status, "drafting"),
              ),
            )
            .get();

          let targetPlanId: string;
          if (existingPlan) {
            targetPlanId = existingPlan.id;
          } else {
            const seed = seedRefinementDraft(taskId);
            targetPlanId = createId();
            await ctx.db.insert(schema.plans).values({
              id: targetPlanId,
              kind: "refinement",
              status: "drafting",
              projectId,
              taskId,
              goal: `Refine: address operator override on ${payload.id ?? "agent decision"}`,
              draft: JSON.stringify(seed),
              createdAt: now,
              updatedAt: now,
            });
            ctx.events.publish({
              channel: "inbox",
              kind: "plan_created",
              planId: targetPlanId,
              planKind: "refinement",
              projectId,
            });
          }

          await ctx.db.insert(schema.planComments).values({
            id: createId(),
            planId: targetPlanId,
            role: "operator",
            body: renderOverrideComment(payload, input.override),
            createdAt: now,
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "plan_comment_added",
            planId: targetPlanId,
            role: "operator",
            projectId,
          });
          planId = targetPlanId;
        }
      }

      return { ok: true, decisionId: input.decisionId, planId };
    }),

  /* helpers (file-local) — kept above `comments` so the rendering helper is
   * close to its only caller (overrideAgentDecision above). */
  comments: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.decisionComments)
        .where(eq(schema.decisionComments.decisionId, input.decisionId))
        .orderBy(asc(schema.decisionComments.createdAt))
        .all();
    }),

  comment: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.status !== "pending") {
        throw new Error(`decision already ${decision.status} — cannot add comments`);
      }
      // triage: comments fire a follow-up agent pass that re-scores the
      // verdict in place. blocked_run: comments are operator answers to
      // the agent's questions; they're stored verbatim and ride forward
      // as `operatorContext` when the operator approves the retry. Other
      // decision kinds don't have a meaningful comment semantics yet.
      if (decision.kind !== "triage" && decision.kind !== "blocked_run") {
        throw new Error(`comments are not supported on ${decision.kind} decisions`);
      }

      const commentId = createId();
      await ctx.db.insert(schema.decisionComments).values({
        id: commentId,
        decisionId: input.decisionId,
        role: "operator",
        body: input.body.trim(),
        createdAt: Date.now(),
      });

      ctx.events.publish({
        channel: "inbox",
        kind: "comment_added",
        decisionId: input.decisionId,
        role: "operator",
      });

      // For blocked_run, the comment is operator answers — there's no
      // agent re-pass at comment time. The retry happens later when the
      // operator approves; that path gathers all comments and threads
      // them into the new run's prompt as `operatorContext`.
      if (decision.kind !== "triage") {
        return { commentId };
      }

      // Fire the follow-up triage in the background — the mutation returns
      // immediately so the UI shows the operator's message instantly. The
      // agent's reply is broadcast over /ws/inbox when it lands.
      void (async () => {
        try {
          await runFollowupTriage(ctx.db, input.decisionId);
          ctx.events.publish({
            channel: "inbox",
            kind: "comment_added",
            decisionId: input.decisionId,
            role: "agent",
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "decision_updated",
            decisionId: input.decisionId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[triage-followup] ${input.decisionId}: ${message}`);
          // Surface the error in the thread so the operator isn't left waiting
          // on a silent failure.
          await ctx.db.insert(schema.decisionComments).values({
            id: createId(),
            decisionId: input.decisionId,
            role: "agent",
            body: `(follow-up triage failed: ${message.slice(0, 240)})`,
            createdAt: Date.now(),
          });
          ctx.events.publish({
            channel: "inbox",
            kind: "comment_added",
            decisionId: input.decisionId,
            role: "agent",
          });
        }
      })();

      return { commentId };
    }),

  /**
   * Pull an actioned decision back into the inbox. Allowed only for outcomes
   * that produced no downstream artifacts: parked, trashed, or dismissed. An
   * approved triage decision created a plan; an approved blocked_run resumed
   * the run; decompose spawned follow-up sub-decisions. Reverting any of those
   * would leave artifacts orphaned, so we refuse rather than silently drift.
   */
  revert: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const decision = await ctx.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, input.decisionId))
        .get();
      if (!decision) throw new Error("decision not found");
      if (decision.status === "pending") throw new Error("decision is already pending");

      const reversible =
        decision.status === "dismissed" ||
        (decision.status === "actioned" &&
          (decision.outcome.startsWith("parked") || decision.outcome.startsWith("trashed")));
      if (!reversible) {
        throw new Error(
          `cannot restore a ${decision.outcome} decision — would leave downstream artifacts orphaned`,
        );
      }

      await ctx.db
        .update(schema.decisions)
        .set({ status: "pending", actionedAt: null })
        .where(eq(schema.decisions.id, input.decisionId));

      ctx.events.publish({
        channel: "inbox",
        kind: "decision_updated",
        decisionId: input.decisionId,
        projectId: decision.projectId ?? null,
      });

      return { ok: true };
    }),
});
