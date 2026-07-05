import { type AuditSkillFrontmatter, type Db, type Project, schema } from "@factory/db";
import { and, count, eq, max } from "drizzle-orm";
import { submitAudit } from "../audits/submit.ts";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { listAuditSkills } from "../projects/audit-skills.ts";
import { cadenceMs, isCadence, type ScheduledJob } from "./scheduler.ts";

/**
 * The audit-cadence job (ADR-004, amended) — the fifth Watch-scheduler job that
 * finally wires the shipped-but-inert audit primitive to fire automatically.
 *
 * Rather than the bespoke `audit_schedules` table ADR-004 originally sketched,
 * cadence rides the generic ADR-010 scheduler: this job checks hourly and, per
 * eligible project, fires the single most-overdue installed audit skill whose
 * last run is older than the project's configured cadence interval. Due-ness is
 * read straight off the `audits` table (max `started_at` per project+skill), so
 * no parallel schedule store is needed — the audit rows ARE the last-run log.
 *
 * Conservative by construction:
 *  - OFF by default: `autonomy.audit.cadence` is `off` until a project (or the
 *    system default) opts in.
 *  - Tier-gated: only `ceremony ≥ personal` (never `tinker`) projects.
 *  - Active only: archived / background projects are skipped.
 *  - Skip-if-inflight: a project with any running audit is skipped this tick.
 *  - `emergencyStop` halts the whole tick (the portfolio kill-switch).
 *  - Read-mostly: submits through the shared `submitAudit` path, which only ever
 *    produces a report + findings → inbox. It never spawns a run or merges.
 *  - One audit per project per tick: bounds burst load and naturally staggers
 *    installed skills across successive ticks.
 */

export interface AuditCadenceDeps {
  db: Db;
  config: FactoryConfig;
  events: EventBus;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fire one audit for a project+skill. Defaults to the real `submitAudit`
   * (cadence trigger). Injected in tests so due-ness/gating can be exercised
   * without spawning an agent.
   */
  submit?: (project: Project, skillName: string) => Promise<void>;
  /** List installed audit skills for a workdir. Injectable for tests. */
  listSkills?: (workdirPath: string) => Promise<AuditSkillFrontmatter[]>;
}

/** One installed skill and when it last ran for this project (0 = never). */
interface SkillDueness {
  skillName: string;
  lastStartedAt: number;
}

/**
 * Run one cadence tick as of `at`. Exported for deterministic tests. Returns the
 * number of audits fired this tick.
 */
export async function tickAuditCadence(deps: AuditCadenceDeps, at: number): Promise<number> {
  const { db } = deps;
  const listSkills = deps.listSkills ?? listAuditSkills;
  const submit =
    deps.submit ??
    (async (project: Project, skillName: string) => {
      await submitAudit({
        config: deps.config,
        db: deps.db,
        events: deps.events,
        project,
        skillName,
        trigger: "cadence",
      });
    });

  // Portfolio kill-switch: emergencyStop halts EVERY project's cadence this tick.
  if (resolveAutonomyConfig(db).autorun.emergencyStop) return 0;

  // Only active projects are candidates; archiving flips `tag` to "past".
  const projects = db.select().from(schema.projects).where(eq(schema.projects.tag, "active")).all();

  let fired = 0;
  for (const project of projects) {
    // Tier gate: tinker projects skip audit ceremony entirely.
    if (project.ceremony === "tinker") continue;

    const cfg = resolveAutonomyConfig(db, project.id);
    // Per-project belt-and-suspenders on the kill-switch.
    if (cfg.autorun.emergencyStop) continue;

    const cadence = isCadence(cfg.audit.cadence) ? cfg.audit.cadence : "off";
    if (cadence === "off") continue; // off-by-default / not opted in

    const skills = await listSkills(project.workdirPath);
    if (skills.length === 0) continue; // nothing to run

    // Skip-if-inflight: never pile a second audit onto a project that's already
    // running one. The next tick picks it up once the prior audit settles.
    const running =
      db
        .select({ c: count() })
        .from(schema.audits)
        .where(and(eq(schema.audits.projectId, project.id), eq(schema.audits.status, "running")))
        .get()?.c ?? 0;
    if (running > 0) continue;

    const interval = cadenceMs(cadence);
    const dueness: SkillDueness[] = [];
    for (const skill of skills) {
      const lastStartedAt =
        db
          .select({ m: max(schema.audits.startedAt) })
          .from(schema.audits)
          .where(
            and(eq(schema.audits.projectId, project.id), eq(schema.audits.skillName, skill.name)),
          )
          .get()?.m ?? 0;
      if (at - lastStartedAt >= interval) dueness.push({ skillName: skill.name, lastStartedAt });
    }
    if (dueness.length === 0) continue;

    // Fire the single most-overdue skill (never-run = lastStartedAt 0 = most
    // overdue). One per project per tick; successive ticks cycle the rest.
    dueness.sort((a, b) => a.lastStartedAt - b.lastStartedAt);
    const pick = dueness[0];
    if (!pick) continue;
    await submit(project, pick.skillName);
    fired++;
  }
  return fired;
}

/**
 * The audit-cadence scheduled job. Fixed `hourly` check frequency — cheap
 * (a couple of indexed count/max queries per active project) and frequent
 * enough to honor the full cadence vocabulary (`hourly | daily | weekly`). The
 * real gate is per-project due-ness inside {@link tickAuditCadence}; when no
 * project has opted in, the tick is a no-op.
 */
export function createAuditCadenceJob(deps: AuditCadenceDeps): ScheduledJob {
  const now = deps.now ?? Date.now;
  return {
    id: "audit-cadence",
    cadence: () => "hourly",
    async run() {
      const fired = await tickAuditCadence(deps, now());
      if (fired > 0) console.log(`[audit-cadence] fired ${fired} scheduled audit(s)`);
    },
  };
}
