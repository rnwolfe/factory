import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import { readTaskFile } from "../projects/tasks.ts";

/**
 * Per-scenario operator intervention prompts.
 *
 * When a decision needs human help (blocked run, merge failure), the
 * decision card renders a copy-pastable prompt the operator can drop into
 * an interactive agent (claude or codex) to drive the recovery. Each
 * scenario carries its own minimal information set — branch, worktree,
 * relevant questions or conflict files, run summary — so the prompt is
 * runnable verbatim instead of forcing the operator to dig up paths.
 *
 * Adding a new intervention scenario:
 * 1. Add a discriminator to {@link InterventionScenario}.
 * 2. Add a case to {@link classifyDecision} mapping the decision payload.
 * 3. Add a case to {@link renderPromptForScenario} that builds the body.
 *
 * The PWA is scenario-aware (renders the scenario label as the prompt
 * heading) but doesn't reach into the body — every consumer treats the
 * rendered text as opaque.
 */
export type InterventionScenario =
  | "blocked_run_failed"
  | "blocked_run_questions"
  | "blocked_run_usage_capped"
  | "merge_failure_dirty"
  | "merge_failure_conflict"
  | "merge_failure_other";

export interface InterventionContext {
  scenario: InterventionScenario;
  /** Short, human-readable title for the prompt block on the decision card. */
  title: string;
  /** The actual prompt body to paste into the interactive agent. */
  prompt: string;
}

/**
 * Public entry point. Looks up the decision, joins to the related run +
 * project + (optionally) the task file, classifies the scenario, and
 * renders the prompt. Returns null for decision kinds that don't need an
 * intervention prompt (`tag_change`, `triage`, `agent_decision`, etc.).
 */
export async function buildInterventionPrompt(
  db: Db,
  decisionId: string,
): Promise<InterventionContext | null> {
  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!decision) return null;
  if (decision.kind !== "blocked_run" && decision.kind !== "merge_failure") {
    return null;
  }

  const payload = (decision.payload ?? {}) as Record<string, unknown>;
  const scenario = classifyDecision(decision.kind, payload);
  if (!scenario) return null;

  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const run = runId
    ? await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()
    : null;
  const projectId = run?.projectId ?? decision.projectId ?? null;
  const project = projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
    : null;

  // The task body is the operator's source-of-truth for what the run was
  // supposed to do — we include it verbatim so the recovering agent can
  // judge "done" against the same criteria.
  let taskBody: string | null = null;
  if (project && run?.taskId) {
    const taskFile = await readTaskFile(project.workdirPath, run.taskId);
    taskBody = taskFile?.body ?? null;
  }

  return renderPromptForScenario(scenario, {
    decision,
    payload,
    run,
    project,
    taskBody,
  });
}

function classifyDecision(
  kind: string,
  payload: Record<string, unknown>,
): InterventionScenario | null {
  if (kind === "blocked_run") {
    if (payload.usageCapped === true) return "blocked_run_usage_capped";
    if (payload.failed === true) return "blocked_run_failed";
    return "blocked_run_questions";
  }
  if (kind === "merge_failure") {
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    if (reason === "dirty") return "merge_failure_dirty";
    if (reason === "conflict") return "merge_failure_conflict";
    return "merge_failure_other";
  }
  return null;
}

interface RenderContext {
  decision: typeof schema.decisions.$inferSelect;
  payload: Record<string, unknown>;
  run: typeof schema.runs.$inferSelect | null | undefined;
  project: typeof schema.projects.$inferSelect | null | undefined;
  taskBody: string | null;
}

function renderPromptForScenario(
  scenario: InterventionScenario,
  ctx: RenderContext,
): InterventionContext {
  switch (scenario) {
    case "blocked_run_failed":
      return {
        scenario,
        title: "Continue a run that died without a status block",
        prompt: renderBlockedRunFailed(ctx),
      };
    case "blocked_run_questions":
      return {
        scenario,
        title: "Resolve a blocked run's questions and continue",
        prompt: renderBlockedRunQuestions(ctx),
      };
    case "blocked_run_usage_capped":
      return {
        scenario,
        title: "Resume a run after a usage-cap pause",
        prompt: renderBlockedRunUsageCapped(ctx),
      };
    case "merge_failure_dirty":
      return {
        scenario,
        title: "Land a run's commits when the target tree is dirty",
        prompt: renderMergeFailureDirty(ctx),
      };
    case "merge_failure_conflict":
      return {
        scenario,
        title: "Resolve a merge conflict between a run branch and main",
        prompt: renderMergeFailureConflict(ctx),
      };
    case "merge_failure_other":
      return {
        scenario,
        title: "Investigate a merge failure",
        prompt: renderMergeFailureOther(ctx),
      };
  }
}

// ---- Renderers ----

function ctxBlock(ctx: RenderContext, extras: Record<string, string | null | undefined>): string {
  const lines: string[] = [];
  if (ctx.project) {
    lines.push(`- Project: ${ctx.project.name} (\`${ctx.project.workdirPath}\`)`);
  }
  if (ctx.run) {
    lines.push(`- Run id: ${ctx.run.id}`);
    if (ctx.run.taskId) lines.push(`- Task: ${ctx.run.taskId}`);
    lines.push(`- Branch: \`${ctx.run.branch}\``);
    lines.push(`- Worktree: \`${ctx.run.worktreePath}\``);
    if (ctx.run.baseRef) lines.push(`- Base ref: \`${ctx.run.baseRef}\``);
    lines.push(`- Agent: ${ctx.run.agentName}`);
  }
  for (const [k, v] of Object.entries(extras)) {
    if (v != null && v.length > 0) lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}

function taskBodyBlock(ctx: RenderContext): string {
  if (!ctx.taskBody) return "";
  const trimmed = ctx.taskBody.trim();
  if (trimmed.length === 0) return "";
  return `\n\n## Task body (verbatim from \`.factory/work/${ctx.run?.taskId ?? ""}…\`)\n\n${trimmed}`;
}

function summaryStr(ctx: RenderContext): string | null {
  const s = ctx.run?.summary;
  return typeof s === "string" && s.length > 0 ? s : null;
}

function renderBlockedRunFailed(ctx: RenderContext): string {
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
  });
  return `A Factory run ended without emitting the required \`factory-status\` block — the agent died mid-task. Any work that made it through was auto-committed to the run branch by Factory's safety net, but the run is marked \`failed\` and won't auto-merge.

${context}

## What I need

1. \`cd\` into the worktree above.
2. Run \`git log ${ctx.run?.baseRef ?? "main"}..HEAD\` to see what's already been committed on the branch.
3. Run \`git diff main..HEAD\` to see the cumulative change vs. main.
4. Read the task body below for what the run was supposed to accomplish.
5. Pick up where the prior agent left off. If a clear next step exists, do it. If you're not sure whether the task is already done, run the project's typecheck + tests against the branch to verify, and report what you find.
6. When done, commit any new work and confirm by \`git log main..HEAD\`. The operator will trigger the merge to main; you don't need to merge.${taskBodyBlock(ctx)}
`;
}

function renderBlockedRunQuestions(ctx: RenderContext): string {
  const questions = Array.isArray(ctx.payload.questions)
    ? (ctx.payload.questions as unknown[]).filter((q): q is string => typeof q === "string")
    : [];
  const questionsBlock =
    questions.length > 0
      ? questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "_(no questions captured — see Summary)_";
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
  });
  return `A Factory run blocked itself with questions the agent couldn't answer on its own. The work-so-far is committed on the run branch; the run is marked \`blocked\` waiting for the operator to weigh in.

${context}

## Questions the agent asked

${questionsBlock}

## What I need

1. \`cd\` into the worktree above.
2. Read the agent's questions above. Decide the answers based on the task body below and your judgement.
3. Continue the work in the worktree: implement the decisions, edit code as needed, commit on the branch.
4. If, while doing the work, you realize the right answer points at a different approach than the questions assume, take that — note your reasoning in the commit message.
5. When done, confirm with \`git log main..HEAD\` that your commits are on the branch. The operator handles the merge.${taskBodyBlock(ctx)}
`;
}

function renderBlockedRunUsageCapped(ctx: RenderContext): string {
  const message = typeof ctx.payload.message === "string" ? ctx.payload.message : null;
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
    "Cap message": message,
  });
  return `A Factory run hit its account's usage cap and paused mid-task. Work-so-far is committed on the run branch and the agent's prior session id is preserved so the same conversation can be resumed.

${context}

## What I need

The cap has likely reset by now (or you've decided to pick this up on your own quota). Either:

- **If you're running this through Factory:** approve the pending blocked-run decision in the inbox — Factory will resume the original Claude session via \`--resume <sessionId>\` and the agent will pick up where it left off with full context.
- **If you're driving manually:** \`cd\` into the worktree, read the task body below + the prior run summary, and continue the work. Commit on the branch when done.${taskBodyBlock(ctx)}
`;
}

function renderMergeFailureDirty(ctx: RenderContext): string {
  const message = typeof ctx.payload.message === "string" ? ctx.payload.message : null;
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
    "Merge failure": message,
  });
  return `A Factory run succeeded and produced commits on its branch, but the auto-merge into main refused because the target tree had uncommitted changes at merge time.

${context}

## What I need

1. \`cd ${ctx.project?.workdirPath ?? "<project workdir>"}\`
2. \`git status\` — see what's uncommitted.
3. Decide what to do with the uncommitted state: commit it, stash it, or discard. Use your judgement based on what's there.
4. Once the tree is clean, attempt the merge: \`git merge --no-ff ${ctx.run?.branch ?? "<branch>"}\` with a sensible merge message.
5. If conflicts surface during the merge, resolve them: read both versions of each conflicted file, decide the right combined state, \`git add\` the resolved files, \`git commit\` to complete the merge.
6. Verify the build still passes — at minimum \`bun run typecheck && bun run check\`; ideally the relevant tests too.

### Sanity check before merging

If \`${ctx.run?.branch ?? "<branch>"}\` is stale (forked off a long-since-superseded main tip), the merge may be destructive. Quick check:

\`\`\`
git log main..${ctx.run?.branch ?? "<branch>"} --oneline | head
git log ${ctx.run?.branch ?? "<branch>"}..main --oneline | head
\`\`\`

If the branch is well-behind main and the work it represents has already landed via a different path, **abandon the branch** (dismiss this merge-failure decision; \`git worktree remove\` the run's worktree) instead of forcing the merge.
`;
}

function renderMergeFailureConflict(ctx: RenderContext): string {
  const message = typeof ctx.payload.message === "string" ? ctx.payload.message : null;
  // Best-effort: extract conflict file paths from the merge message.
  const conflictFiles =
    message
      ?.match(/(?:CONFLICT.*?in |Merge conflict in )([^\s)]+)/g)
      ?.map((s) => s.replace(/^(?:CONFLICT.*?in |Merge conflict in )/, "")) ?? [];
  const filesBlock =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- \`${f}\``).join("\n")
      : "_(see merge message below)_";
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
    "Merge message": message,
  });
  return `A Factory run produced commits that don't auto-merge into main — there are conflicts. The branch has the agent's work; main has changes that landed in parallel.

${context}

## Conflicted files

${filesBlock}

## What I need

1. \`cd ${ctx.project?.workdirPath ?? "<project workdir>"}\`
2. Re-attempt the merge so the conflicts surface in the tree: \`git merge --no-ff ${ctx.run?.branch ?? "<branch>"}\`
3. For each conflicted file:
   - Read the conflicted state (between \`<<<<<<< \` and \`>>>>>>> \`).
   - Decide the right combined state. The agent's intent is captured in the branch's commits; main's intent is captured in main's recent commits.
   - Edit the file to its correct combined form, removing the conflict markers.
4. \`git add\` the resolved files. \`git commit\` (the editor will open with a default merge-commit message; tweak if useful).
5. Verify: \`bun run typecheck && bun run check\`. Run relevant tests if the change is substantial.
6. Report when done.

If the branch's work has already landed via a different path (check \`git log main\` for similar commits), the right move may be to abandon — dismiss the merge-failure decision and \`git worktree remove\` the run's worktree.
`;
}

function renderMergeFailureOther(ctx: RenderContext): string {
  const reason = typeof ctx.payload.reason === "string" ? ctx.payload.reason : "unknown";
  const message = typeof ctx.payload.message === "string" ? ctx.payload.message : null;
  const context = ctxBlock(ctx, {
    Summary: summaryStr(ctx),
    Reason: reason,
    "Merge message": message,
  });
  return `Factory's auto-merge into main refused for a reason that isn't a clean conflict or dirty-tree: \`${reason}\`. The work is on the run branch; main is untouched.

${context}

## What I need

1. \`cd ${ctx.project?.workdirPath ?? "<project workdir>"}\`
2. Inspect the failure: re-attempt the merge by hand, read the merge message, figure out what's blocking it.
3. Decide whether to resolve and merge, or abandon the branch.
4. If merging, verify the build after, then report what you did.
5. If abandoning, dismiss this decision and \`git worktree remove\` the run's worktree.
`;
}
