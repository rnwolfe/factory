import { schema } from "@factory/db";
import { mergeIntoMain } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { AGENT_NAME_ENUM } from "../agents/registry.ts";
import { echoOperatorCommentToIssue, runDecisionReply } from "../decisions/dialog.ts";
import {
  type AgentDecisionOverride,
  emitResurfaceSignal,
  resurfaceAnswer,
  resurfaceWorkForDecision,
} from "../decisions/resurface.ts";
import { inboxViewInput, snoozeInput, snoozeWhere } from "../inbox-snooze.ts";
import { defaultOperatorMemoryPath, slugify, writeMemoryFact } from "../memory/operator-memory.ts";
import { seedFeaturePlanDraft, seedProjectSpecDraft } from "../plans/iterate.ts";
import { schedulePlanIteration } from "../plans/schedule.ts";
import { adoptIssue } from "../projects/github-task-store.ts";
import { createTask, updateTaskStatus } from "../projects/tasks.ts";
import { runFollowupTriage, type TriageDecisionPayload } from "../triage/orchestrate.ts";
import { protectedProcedure, router } from "../trpc.ts";
import type { WatchInsightPayload } from "../watch/observation-inbox.ts";
import { applyPostMergeRunOutcome } from "../workers/post-merge.ts";
import { submitRun } from "../workers/submit.ts";

interface ReleaseProposalPayload {
  templateSlug: string;
  version: string | null;
  title: string;
  body: string;
  labels?: string[];
  priority?: "low" | "med" | "high";
  estimate?: "small" | "medium" | "large";
}

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
  override?: AgentDecisionOverride;
  overrideAt?: number;
  /**
   * The re-queued unit of work the override resurfaced into (task-064). Pinned
   * onto the decision payload so every decision surface — inbox history, the
   * decision detail page — can render the override as still-open work linked to
   * its follow-up task, rather than a closed "decided". Null when there was no
   * backend to re-queue into (ad-hoc run with no project) or the re-queue failed.
   */
  resurfacedTaskId?: string | null;
}

const decisionWithProjectSelect = {
  id: schema.decisions.id,
  kind: schema.decisions.kind,
  ideaId: schema.decisions.ideaId,
  projectId: schema.decisions.projectId,
  projectName: schema.projects.name,
  rubricVersionId: schema.decisions.rubricVersionId,
  outcome: schema.decisions.outcome,
  payload: schema.decisions.payload,
  uncertainty: schema.decisions.uncertainty,
  weightedScore: schema.decisions.weightedScore,
  status: schema.decisions.status,
  snoozedUntil: schema.decisions.snoozedUntil,
  createdAt: schema.decisions.createdAt,
  actionedAt: schema.decisions.actionedAt,
};

export const decisionsRouter = router({
  inbox: protectedProcedure.input(inboxViewInput).query(async ({ ctx, input }) => {
    const now = Date.now();
    return ctx.db
      .select(decisionWithProjectSelect)
      .from(schema.decisions)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.decisions.projectId))
      .where(
        and(
          eq(schema.decisions.status, "pending"),
          snoozeWhere(schema.decisions.snoozedUntil, input.view, now),
        ),
      )
      .orderBy(desc(schema.decisions.createdAt))
      .all();
  }),

  snooze: protectedProcedure.input(snoozeInput).mutation(async ({ ctx, input }) => {
    const existing = await ctx.db
      .select({ id: schema.decisions.id, status: schema.decisions.status })
      .from(schema.decisions)
      .where(eq(schema.decisions.id, input.id))
      .get();
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "decision not found" });
    if (existing.status !== "pending") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "decision is not pending" });
    }

    await ctx.db
      .update(schema.decisions)
      .set({ snoozedUntil: input.snoozedUntil })
      .where(eq(schema.decisions.id, input.id));

    ctx.events.publish({
      channel: "inbox",
      kind: "decision_updated",
      decisionId: input.id,
    });

    return ctx.db
      .select(decisionWithProjectSelect)
      .from(schema.decisions)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.decisions.projectId))
      .where(eq(schema.decisions.id, input.id))
      .get();
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(50) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select(decisionWithProjectSelect)
        .from(schema.decisions)
        .leftJoin(schema.projects, eq(schema.projects.id, schema.decisions.projectId))
        .where(ne(schema.decisions.status, "pending"))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(input.limit)
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return (
      ctx.db
        .select(decisionWithProjectSelect)
        .from(schema.decisions)
        .leftJoin(schema.projects, eq(schema.projects.id, schema.decisions.projectId))
        .where(eq(schema.decisions.id, input.id))
        .get() ?? null
    );
  }),

  action: protectedProcedure
    .input(
      z.object({
        decisionId: z.string(),
        action: ActionEnum,
        note: z.string().optional(),
        /** Model id for the project's runs. Approve-only; ignored otherwise. */
        model: z.string().nullable().optional(),
        /**
         * Headless agent for this run / project. On blocked_run approve, scoped
         * to the retry run only. On triage approve, persists onto the bootstrapped
         * project. Ignored otherwise.
         */
        agent: AGENT_NAME_ENUM.optional(),
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

        // The runner held the post-merge side-effects (task status reconcile
        // + auto-advance) when the original merge failed. Now that the
        // operator-approved retry has landed, fire them here. Scoped to run-
        // backed merge_failure decisions; the ad-hoc-session variant carries
        // a `sessionId` instead and has no task to reconcile.
        if (payload.runId) {
          try {
            await applyPostMergeRunOutcome(
              {
                config: ctx.config,
                db: ctx.db,
                events: ctx.events,
                runs: ctx.runs,
                pool: ctx.pool,
              },
              payload.runId,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[decisions] post-merge reconcile failed for run ${payload.runId}: ${msg}`,
            );
          }
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
                agent: input.agent,
              }
            : {
                projectId: source.projectId,
                taskId: source.taskId ?? undefined,
                baseRef: source.branch,
                operatorContext,
                agent: input.agent,
              },
        );
        retryRunId = result.runId;
        projectId = source.projectId;

        // Record the blocker→reply→re-run loop as a first-class dialog
        // intervention (task-049) so the chain is queryable, not scattered
        // across runs/decision_comments. Best-effort — never block the retry.
        try {
          const { interventionLog } = await import("../interventions/log.ts");
          await interventionLog(ctx.db).recordDialog({
            decisionId: decision.id,
            projectId: source.projectId,
            sourceRunId: payload.runId,
            worktreePath: source.worktreePath,
            tmuxSessionName: source.tmuxSession ?? "",
            blockerQuestions: Array.isArray(payload.questions) ? payload.questions : [],
            operatorReply: operatorContext,
            retryRunId: result.runId,
          });
        } catch (err) {
          console.error(
            `[intervention-log] ${decision.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
        if (planId) {
          schedulePlanIteration(ctx, { planId });
        }
      }

      if (input.action === "approve" && decision.kind === "issue_intake") {
        // Adopt the externally-authored issue as a Factory task: add the
        // factory + status:ready labels and frontmatter so it joins the
        // project's task set. Dismiss just leaves the issue untracked.
        if (!decision.projectId) throw new Error("issue_intake decision missing projectId");
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, decision.projectId))
          .get();
        if (!project) throw new Error("project not found");
        const payload = decision.payload as { number: number };
        const adopted = await adoptIssue(ctx.config, project, String(payload.number));
        if (!adopted) {
          throw new Error(
            `could not adopt issue #${payload.number} — App unconfigured or issue missing`,
          );
        }
        projectId = project.id;
      }

      if (input.action === "approve" && decision.kind === "release_proposal") {
        // Confirm a release proposal: materialize the (already model-rendered)
        // release task and submit a run to execute it. The version + changelog
        // prose were resolved at proposal time and live in the decision payload;
        // dismiss just discards the proposal, leaving no task behind.
        if (!decision.projectId) throw new Error("release_proposal decision missing projectId");
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, decision.projectId))
          .get();
        if (!project) throw new Error("project not found");
        const payload = decision.payload as ReleaseProposalPayload;
        const created = await createTask(project, {
          title: payload.title,
          body: payload.body,
          labels: payload.labels ?? ["release"],
          priority: payload.priority ?? "med",
          estimate: payload.estimate ?? "small",
        });
        const result = await submitRun(
          {
            config: ctx.config,
            db: ctx.db,
            events: ctx.events,
            runs: ctx.runs,
            pool: ctx.pool,
          },
          {
            projectId: project.id,
            taskId: created.id,
            agent: input.agent,
            // Mark this as a release run so the runner pushes main + the tag
            // after the merge. The agent creates the annotated tag named after
            // the confirmed version; a null version → no auto-push (the run
            // still cuts locally and the operator pushes).
            releaseTag: payload.version ?? undefined,
          },
        );
        retryRunId = result.runId;
        projectId = project.id;
      }

      if (decision.kind === "watch_insight") {
        // An insight from The Watch. `approve` adopts it: adopt-as-task creates a
        // task (when it maps to a project); record-as-convention writes the
        // convention into the operator-memory repo; note-only is a plain
        // acknowledgement. `dismiss` declines it. Either way the observation's
        // status moves off `surfaced` so it stays out of the inbox.
        const payload = decision.payload as WatchInsightPayload;
        if (input.action === "approve") {
          if (payload.proposal === "adopt-as-task" && decision.projectId) {
            const project = await ctx.db
              .select()
              .from(schema.projects)
              .where(eq(schema.projects.id, decision.projectId))
              .get();
            if (project) {
              const sessions = payload.evidence
                .map((e) => `${e.sourceId}/${e.sessionId.slice(0, 8)}`)
                .join(", ");
              const provenance = sessions
                ? `\n\n_From The Watch — observed across ${payload.evidence.length} out-of-band session(s): ${sessions}._`
                : "\n\n_From The Watch._";
              await createTask(project, {
                title: payload.title,
                body: `${payload.detail}${provenance}`,
                labels: ["watch", payload.observationKind],
                priority: "med",
                estimate: "small",
              });
              projectId = project.id;
            }
          } else if (payload.proposal === "record-as-convention") {
            // Write an operator-level convention into the operator-memory repo
            // (ADR-010 §4). Best-effort: a git hiccup must not fail the action.
            try {
              await writeMemoryFact(defaultOperatorMemoryPath(ctx.config.workdir), {
                name: slugify(payload.title),
                description: payload.title,
                type: "feedback",
                body: `${payload.detail}\n\n_Recorded from a Watch observation (${payload.observationKind})._`,
                provenance: [
                  `watch:${payload.observationId}`,
                  ...payload.evidence.map((e) => `${e.sourceId}/${e.sessionId.slice(0, 8)}`),
                ],
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[memory] record-as-convention write failed: ${msg}`);
            }
          } else if (payload.proposal === "draft-feature-plan" && decision.projectId) {
            // Seed a drafting feature_plan the operator iterates to freeze — the
            // same seam as triage→project_spec, but scoped to an existing project.
            // Idempotent on the decision; the freeze gate + vision filter stay intact.
            const existing = await ctx.db
              .select({ id: schema.plans.id })
              .from(schema.plans)
              .where(
                and(
                  eq(schema.plans.decisionId, decision.id),
                  eq(schema.plans.kind, "feature_plan"),
                ),
              )
              .get();
            let planId = existing?.id ?? null;
            if (!planId) {
              const id = createId();
              const tnow = Date.now();
              await ctx.db.insert(schema.plans).values({
                id,
                kind: "feature_plan",
                status: "drafting",
                decisionId: decision.id,
                projectId: decision.projectId,
                goal: payload.title,
                draft: JSON.stringify(seedFeaturePlanDraft(payload.title)),
                createdAt: tnow,
                updatedAt: tnow,
              });
              planId = id;
              ctx.events.publish({
                channel: "inbox",
                kind: "plan_created",
                planId: id,
                planKind: "feature_plan",
              });
            }
            schedulePlanIteration(ctx, { planId });
            projectId = decision.projectId;
          } else if (
            payload.proposal === "groom-backlog" &&
            decision.projectId &&
            payload.targetTaskId
          ) {
            // Close a stale backlog task the operator confirms is obsolete —
            // through the task seam (status → dropped). Best-effort: a file/IO
            // hiccup must not fail the action.
            const project = await ctx.db
              .select()
              .from(schema.projects)
              .where(eq(schema.projects.id, decision.projectId))
              .get();
            if (project) {
              try {
                await updateTaskStatus(project, payload.targetTaskId, "dropped");
                projectId = project.id;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[watch] groom-backlog close failed: ${msg}`);
              }
            }
          }
          await ctx.db
            .update(schema.watchObservations)
            .set({ status: "adopted", updatedAt: Date.now() })
            .where(eq(schema.watchObservations.id, payload.observationId));
        } else if (input.action === "dismiss") {
          await ctx.db
            .update(schema.watchObservations)
            .set({ status: "dismissed", updatedAt: Date.now() })
            .where(eq(schema.watchObservations.id, payload.observationId));
        }
      }

      // `approve` on an `agent_decision` is ratification: the operator accepts
      // the agent's proposed answer verbatim. It deliberately falls through to
      // here with no side effect — the agent already wrote its call into the
      // worktree during the run, so the work stays closed and nothing
      // resurfaces. Non-ratification routes through `overrideAgentDecision`
      // instead, which emits a resurfacing signal (task-061).
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
   * The decision row is marked actioned with the operator's choice appended to
   * the payload (so the audit trail stays uniform), a resurfacing signal is
   * emitted (task-061), and the overridden work is re-queued as a concrete unit
   * through the backend-agnostic task-store seam (task-062). The re-queue is
   * uniform across backends: a non-GitHub project gets a `.factory/work` task, a
   * GitHub project a follow-up issue — both from the one `createTask` seam.
   *
   * Ad-hoc runs with no project can be overridden but have no backend to
   * re-queue into — the operator's preference is captured on the decision row
   * (and the resurfacing signal) only. They can still see it in history.
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
      // Trust Ladder (ADR-012): override is the safety valve for auto-ratified
      // forks too — an `auto_ratified` decision (L2+) is overridable post-hoc,
      // exactly like a `pending` one. Already-overridden (`actioned`) or
      // `dismissed` decisions are terminal.
      if (decision.status !== "pending" && decision.status !== "auto_ratified") {
        throw new Error(`decision already ${decision.status}`);
      }

      const payload = (decision.payload ?? {}) as AgentDecisionPayloadShape;
      const projectId = decision.projectId;
      const taskId = payload.taskId ?? null;
      const now = Date.now();
      const answer = resurfaceAnswer(input.override);

      // The operator did not ratify — they picked a different option, changed
      // the selected subset, or wrote a custom answer. Any such non-ratification
      // must resurface for implementation rather than silently close. Emit the
      // signal unconditionally (task-061): it fires even for ad-hoc runs with no
      // project, so live surfaces always learn of the override. The backend-
      // agnostic re-queue below (task-062) then materializes the concrete unit
      // of work for any project that has a backend.
      emitResurfaceSignal(ctx.events, {
        decisionId: input.decisionId,
        projectId: projectId ?? null,
        taskId,
        runId: payload.runId ?? null,
        agentDecided: payload.decided ?? null,
        answer,
        override: input.override,
        at: now,
      });

      // Re-queue the overridden work as a concrete unit of work through the
      // backend-agnostic task-store seam (task-062). `resurfaceWorkForDecision`
      // → `createTask` dispatches to whichever backend the project uses, so the
      // non-GitHub (file) and GitHub-Issue backends both re-queue from this one
      // call. The created task carries `sourceDecisionId` for the audit trail.
      //
      // Best-effort: the override has not yet been persisted, but a backend
      // hiccup (e.g. an unconfigured GitHub App, a missing task dir) must never
      // fail the operator's action — we log and still mark the decision actioned
      // so it leaves the inbox. The resurfacing signal already fired regardless.
      let resurfacedTaskId: string | null = null;
      if (projectId) {
        const project = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get();
        if (project) {
          try {
            const requeued = await resurfaceWorkForDecision(project, {
              decisionId: input.decisionId,
              summary: payload.summary ?? null,
              agentDecided: payload.decided ?? null,
              answer,
              originalTaskId: taskId,
              runId: payload.runId ?? null,
              options: payload.options,
            });
            resurfacedTaskId = requeued.id;
          } catch (err) {
            console.error(
              `[decisions] resurface re-queue failed for ${input.decisionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }

      // Persist the override AND the resurfaced-task pointer on the decision
      // payload in one write. We keep the original agent payload intact and add
      // `override` + `overrideAt` (audit trail: what the agent picked vs. what
      // the operator preferred) and `resurfacedTaskId` so every decision surface
      // can link the override to its still-open follow-up task (task-064).
      const newPayload: AgentDecisionPayloadShape = {
        ...payload,
        override: input.override,
        overrideAt: now,
        resurfacedTaskId,
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

      return { ok: true, decisionId: input.decisionId, projectId, resurfacedTaskId };
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
      if (
        decision.kind !== "triage" &&
        decision.kind !== "blocked_run" &&
        decision.kind !== "issue_intake" &&
        decision.kind !== "agent_decision"
      ) {
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

      // issue_intake: an operator comment from the PWA gets an agent reply
      // (re-triage), echoed back to the GitHub issue as factory[bot] — the
      // github-issues parity for the file backend's comment loop (task-048).
      if (decision.kind === "issue_intake") {
        const project = decision.projectId
          ? await ctx.db
              .select()
              .from(schema.projects)
              .where(eq(schema.projects.id, decision.projectId))
              .get()
          : null;
        if (project) {
          void (async () => {
            try {
              const { runIssueIntakeReply } = await import("../github/issue-triage.ts");
              await runIssueIntakeReply(
                { db: ctx.db, events: ctx.events, config: ctx.config, project },
                input.decisionId,
              );
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
              console.error(
                `[issue-triage] ${input.decisionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })();
        }
        return { commentId };
      }

      // blocked_run / needs_review / agent_decision: the operator's comment gets
      // a live agent reply (not silent storage) — the dialog parity triage and
      // issue_intake already have. For a github-issues task we also echo the
      // operator's comment to the issue thread, so the conversation lives in
      // both places. The blocked_run retry still folds the operator's answers
      // into `operatorContext` on approve — that path filters to role=operator,
      // so the agent reply added here never pollutes it.
      if (decision.kind === "blocked_run" || decision.kind === "agent_decision") {
        const project = decision.projectId
          ? await ctx.db
              .select()
              .from(schema.projects)
              .where(eq(schema.projects.id, decision.projectId))
              .get()
          : null;
        if (project) {
          const payload = (decision.payload ?? {}) as { taskId?: string | null };
          void echoOperatorCommentToIssue(ctx.config, project, payload, input.body.trim());
          void (async () => {
            try {
              await runDecisionReply(
                { db: ctx.db, events: ctx.events, config: ctx.config, project },
                input.decisionId,
              );
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
              console.error(
                `[decision-reply] ${input.decisionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })();
        }
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
