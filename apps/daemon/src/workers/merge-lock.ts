import { KeyedMutex } from "./keyed-mutex.ts";

/**
 * Serializes the merge-into-main section of run finalization per project.
 * Module-level so every `executeRun` that reaches the merge block shares one
 * lock keyed by projectId.
 *
 * The worker pool runs up to 4 runs concurrently, and auto-advance can chain
 * several against one project in quick succession. When two runs against the
 * same project finalize at overlapping moments, each independently drives git
 * on the project checkout (`git status`, `git checkout main`, `git merge`, the
 * dirty-reset / conflict-resolve remediation paths). Two git processes writing
 * the same repo collide on `.git/index.lock` — the loser fails with
 * "Unable to create '.../index.lock': File exists" / "another git process
 * seems to be running", `mergeIntoMain` returns a non-`ok` result, and a run
 * that genuinely completed is spuriously surfaced as a merge failure (or, on
 * the autonomous gate path, held for review) instead of landing on main.
 *
 * Holding this lock across the whole merge section makes the git operations of
 * two same-project runs strictly ordered — the second run's merge starts only
 * after the first's finishes. Different projects key differently and never
 * contend, so unrelated projects still merge concurrently.
 *
 * This is the merge analog of `post-merge.ts`'s `autoAdvanceLock`: same
 * primitive, same per-project keying, a different critical section.
 */
export const mergeLock = new KeyedMutex();
