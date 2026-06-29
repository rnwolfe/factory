import { agentsRouter } from "./routers/agents.ts";
import { auditsRouter } from "./routers/audits.ts";
import { autonomyRouter } from "./routers/autonomy.ts";
import { changelogRouter } from "./routers/changelog.ts";
import { decisionsRouter } from "./routers/decisions.ts";
import { deferredTasksRouter } from "./routers/deferred-tasks.ts";
import { feedbackRouter } from "./routers/feedback.ts";
import { healthRouter } from "./routers/health.ts";
import { ideasRouter } from "./routers/ideas.ts";
import { interventionsRouter } from "./routers/interventions.ts";
import { memoryRouter } from "./routers/memory.ts";
import { metricsRouter } from "./routers/metrics.ts";
import { notificationsRouter } from "./routers/notifications.ts";
import { opsRouter } from "./routers/ops.ts";
import { plansRouter } from "./routers/plans.ts";
import { projectsRouter } from "./routers/projects.ts";
import { promptsRouter } from "./routers/prompts.ts";
import { recoveryPromptsRouter } from "./routers/recovery-prompts.ts";
import { repoRouter } from "./routers/repo.ts";
import { rubricsRouter } from "./routers/rubrics.ts";
import { runsRouter } from "./routers/runs.ts";
import { scriptsRouter } from "./routers/scripts.ts";
import { sessionsRouter } from "./routers/sessions.ts";
import { settingsRouter } from "./routers/settings.ts";
import { skillsRouter } from "./routers/skills.ts";
import { taskTemplatesRouter } from "./routers/task-templates.ts";
import { watchRouter } from "./routers/watch.ts";
import { worktreesRouter } from "./routers/worktrees.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  health: healthRouter,
  ideas: ideasRouter,
  decisions: decisionsRouter,
  deferredTasks: deferredTasksRouter,
  feedback: feedbackRouter,
  interventions: interventionsRouter,
  recoveryPrompts: recoveryPromptsRouter,
  plans: plansRouter,
  projects: projectsRouter,
  prompts: promptsRouter,
  runs: runsRouter,
  rubrics: rubricsRouter,
  agents: agentsRouter,
  audits: auditsRouter,
  autonomy: autonomyRouter,
  changelog: changelogRouter,
  memory: memoryRouter,
  metrics: metricsRouter,
  notifications: notificationsRouter,
  ops: opsRouter,
  repo: repoRouter,
  scripts: scriptsRouter,
  sessions: sessionsRouter,
  settings: settingsRouter,
  skills: skillsRouter,
  taskTemplates: taskTemplatesRouter,
  watch: watchRouter,
  worktrees: worktreesRouter,
});

export type AppRouter = typeof appRouter;
