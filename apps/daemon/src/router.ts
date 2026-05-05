import { auditsRouter } from "./routers/audits.ts";
import { decisionsRouter } from "./routers/decisions.ts";
import { feedbackRouter } from "./routers/feedback.ts";
import { healthRouter } from "./routers/health.ts";
import { ideasRouter } from "./routers/ideas.ts";
import { metricsRouter } from "./routers/metrics.ts";
import { plansRouter } from "./routers/plans.ts";
import { projectsRouter } from "./routers/projects.ts";
import { promptsRouter } from "./routers/prompts.ts";
import { repoRouter } from "./routers/repo.ts";
import { rubricsRouter } from "./routers/rubrics.ts";
import { runsRouter } from "./routers/runs.ts";
import { scriptsRouter } from "./routers/scripts.ts";
import { sessionsRouter } from "./routers/sessions.ts";
import { settingsRouter } from "./routers/settings.ts";
import { worktreesRouter } from "./routers/worktrees.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  health: healthRouter,
  ideas: ideasRouter,
  decisions: decisionsRouter,
  feedback: feedbackRouter,
  plans: plansRouter,
  projects: projectsRouter,
  prompts: promptsRouter,
  runs: runsRouter,
  rubrics: rubricsRouter,
  audits: auditsRouter,
  metrics: metricsRouter,
  repo: repoRouter,
  scripts: scriptsRouter,
  sessions: sessionsRouter,
  settings: settingsRouter,
  worktrees: worktreesRouter,
});

export type AppRouter = typeof appRouter;
