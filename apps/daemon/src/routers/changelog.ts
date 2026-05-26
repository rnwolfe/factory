import { loadChangelog } from "../changelog.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const changelogRouter = router({
  /**
   * The newest entry — what we surface in the auto-opening release-notes
   * sheet on first view after upgrade.
   */
  latest: protectedProcedure.query(() => {
    const entries = loadChangelog();
    return entries[0] ?? null;
  }),

  /**
   * Full history — for the settings → release notes viewer.
   */
  all: protectedProcedure.query(() => loadChangelog()),
});
