import { decisionsRouter } from "./routers/decisions.ts";
import { healthRouter } from "./routers/health.ts";
import { ideasRouter } from "./routers/ideas.ts";
import { plansRouter } from "./routers/plans.ts";
import { projectsRouter } from "./routers/projects.ts";
import { rubricsRouter } from "./routers/rubrics.ts";
import { runsRouter } from "./routers/runs.ts";
import { router } from "./trpc.ts";

export const appRouter = router({
  health: healthRouter,
  ideas: ideasRouter,
  decisions: decisionsRouter,
  plans: plansRouter,
  projects: projectsRouter,
  runs: runsRouter,
  rubrics: rubricsRouter,
});

export type AppRouter = typeof appRouter;
