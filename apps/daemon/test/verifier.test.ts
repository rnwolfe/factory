import { describe, expect, test } from "bun:test";
import type { AcceptanceResult } from "../src/workers/factory-status.ts";
import type { QualityReport } from "../src/workers/quality.ts";
import {
  classifyBlastRadius,
  classifyMilestoneBlastRadius,
  computeVerifierReport,
  decideAutoLand,
  hasActionableDefect,
  isWithinBlastCeiling,
  type MilestoneTaskLike,
} from "../src/workers/verifier.ts";

const mtask = (over: Partial<MilestoneTaskLike> = {}): MilestoneTaskLike => ({
  title: "Wire the settings row",
  estimate: "small",
  acceptance: ["renders", "persists"],
  ...over,
});

const met = (n: number): AcceptanceResult[] =>
  Array.from({ length: n }, (_, i) => ({ criterion: `c${i}`, met: true }));

const quality = (overall: QualityReport["overall"], n = 1): QualityReport => ({
  ranAt: 1,
  overall,
  results: Array.from({ length: n }, (_, i) => ({
    name: `q${i}`,
    command: "x",
    exitCode: overall === "fail" ? 1 : 0,
    durationMs: 1,
    stdoutTail: "",
    stderrTail: "",
    timedOut: false,
  })),
});

function sig(r: ReturnType<typeof computeVerifierReport>, key: string) {
  return r.signals.find((s) => s.key === key);
}

describe("computeVerifierReport", () => {
  test("acceptance met + quality green → full coverage (high)", () => {
    const r = computeVerifierReport({ acceptance: met(3), qualityReport: quality("pass") });
    expect(r.score).toBe(1);
    expect(r.level).toBe("high");
    expect(sig(r, "acceptance")?.state).toBe("pass");
    expect(sig(r, "quality")?.state).toBe("pass");
  });

  test("acceptance met, no quality config → partial (medium, 0.6)", () => {
    const r = computeVerifierReport({ acceptance: met(2), qualityReport: quality("skipped", 0) });
    expect(r.score).toBe(0.6);
    expect(r.level).toBe("medium");
    expect(sig(r, "quality")?.state).toBe("absent");
  });

  test("no acceptance criteria, quality green → low (0.4)", () => {
    const r = computeVerifierReport({ acceptance: [], qualityReport: quality("pass") });
    expect(r.score).toBe(0.4);
    expect(r.level).toBe("low");
    expect(sig(r, "acceptance")?.state).toBe("absent");
  });

  test("completed but NOTHING checked it → score 0 / none (the dangerous case)", () => {
    const r = computeVerifierReport({ acceptance: [], qualityReport: null });
    expect(r.score).toBe(0);
    expect(r.level).toBe("none");
    expect(sig(r, "acceptance")?.state).toBe("absent");
    expect(sig(r, "quality")?.state).toBe("absent");
  });

  test("an unmet acceptance criterion → fail (no positive coverage from it)", () => {
    const acceptance: AcceptanceResult[] = [
      { criterion: "a", met: true },
      { criterion: "b", met: false, reason: "missing" },
    ];
    const r = computeVerifierReport({ acceptance, qualityReport: quality("pass") });
    expect(sig(r, "acceptance")?.state).toBe("fail");
    expect(r.score).toBe(0.4); // only quality contributes
    expect(r.level).toBe("low");
  });

  test("quality failed → fail state, contributes nothing", () => {
    const r = computeVerifierReport({ acceptance: met(1), qualityReport: quality("fail") });
    expect(sig(r, "quality")?.state).toBe("fail");
    expect(r.score).toBe(0.6); // only acceptance contributes
  });

  test("cross-model undefined → excluded (2-signal weighting, no cap)", () => {
    const r = computeVerifierReport({ acceptance: met(1), qualityReport: quality("pass") });
    expect(r.signals.find((s) => s.key === "cross-model")).toBeUndefined();
    expect(r.score).toBe(1); // not capped by a missing 3rd signal
  });

  test("cross-model pass → 3-signal weighting, full coverage", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: { validator: "codex", state: "pass", confidence: 0.9, reasoning: "clean" },
    });
    expect(sig(r, "cross-model")?.state).toBe("pass");
    expect(r.score).toBe(1); // 0.4 + 0.3 + 0.3
    expect(r.level).toBe("high");
  });

  test("cross-model ran but no verdict (null) → absent, lowers the score", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: null,
    });
    expect(sig(r, "cross-model")?.state).toBe("absent");
    expect(r.score).toBe(0.7); // 0.4 + 0.3 + 0 (cross-model absent)
  });

  test("cross-model concerns → concern signal, partial credit still clears high", () => {
    // An advisory hedge is not a defect: acceptance(0.4) + quality(0.3) +
    // concern(0.3 × 0.5 = 0.15) = 0.85 → high. It auto-lands instead of being capped
    // at medium and ground through the retry loop.
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: {
        validator: "claude-code",
        state: "concerns",
        confidence: 0.4,
        reasoning: "risky",
      },
    });
    expect(sig(r, "cross-model")?.state).toBe("concern");
    expect(r.score).toBe(0.85);
    expect(r.level).toBe("high");
  });

  test("cross-model hard fail → fail signal, zero credit (a real defect)", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: { validator: "codex", state: "fail", confidence: 0.9, reasoning: "bug" },
    });
    expect(sig(r, "cross-model")?.state).toBe("fail");
    expect(r.score).toBe(0.7); // 0.4 + 0.3 + 0
    expect(r.level).toBe("medium");
  });
});

describe("hasActionableDefect", () => {
  const base = { acceptance: met(1), qualityReport: quality("pass") };
  test("a hard fail is actionable (drives auto-retry)", () => {
    const r = computeVerifierReport({
      ...base,
      crossModel: { validator: "codex", state: "fail", confidence: 0.9, reasoning: "bug" },
    });
    expect(hasActionableDefect(r)).toBe(true);
  });
  test("a concern is NOT actionable (surface, don't grind retries)", () => {
    const r = computeVerifierReport({
      ...base,
      crossModel: { validator: "codex", state: "concerns", confidence: 0.4, reasoning: "eh" },
    });
    expect(hasActionableDefect(r)).toBe(false);
  });
});

const SMALL_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,2 @@
-old
+new
+more`;

describe("classifyBlastRadius", () => {
  test("a small, non-sensitive diff is contained", () => {
    const b = classifyBlastRadius(SMALL_DIFF);
    expect(b.radius).toBe("contained");
    expect(b.files).toBe(1);
    expect(b.churn).toBe(3);
  });

  test("a migration / risk-sensitive path is broad", () => {
    const diff = `diff --git a/packages/db/src/migrations/0036_x.sql b/packages/db/src/migrations/0036_x.sql
+ALTER TABLE runs ADD col text;`;
    const b = classifyBlastRadius(diff);
    expect(b.radius).toBe("broad");
    expect(b.reasons.join(" ")).toContain("risk-sensitive");
  });

  test("a large diff is broad", () => {
    const big = [
      "diff --git a/src/big.ts b/src/big.ts",
      ...Array.from({ length: 500 }, (_, i) => `+line ${i}`),
    ].join("\n");
    expect(classifyBlastRadius(big).radius).toBe("broad");
  });

  test("Factory's own .factory/ task files don't count toward blast radius", () => {
    // A risky-named task file (e.g. "…-auth-…") must NOT trip the risky-path
    // filter — it's Factory bookkeeping, not shipped project code.
    const diff = `diff --git a/.factory/work/task-012-add-auth-guard.md b/.factory/work/task-012-add-auth-guard.md
+status: done`;
    const b = classifyBlastRadius(diff);
    expect(b.files).toBe(0);
    expect(b.radius).toBe("contained");
  });

  test("a schema DEFINITION change is contained (not risky) — only applied migrations are", () => {
    // schema.ts is code, not an applied change — a schema edit alone must not
    // hold an autonomous run (the greenfield-schema hold this fixes).
    const defOnly = `diff --git a/src/server/db/schema.ts b/src/server/db/schema.ts
+export const households = sqliteTable("households", {});`;
    expect(classifyBlastRadius(defOnly).radius).toBe("contained");

    // But if the change generates an applied migration, THAT is broad.
    const withMigration = `${defOnly}
diff --git a/drizzle/migrations/0001_add_households.sql b/drizzle/migrations/0001_add_households.sql
+CREATE TABLE households (id text primary key);`;
    const b = classifyBlastRadius(withMigration);
    expect(b.radius).toBe("broad");
    expect(b.reasons.join(" ")).toContain("migrations");
  });
});

describe("classifyMilestoneBlastRadius", () => {
  test("a handful of small, benign tasks is contained", () => {
    const b = classifyMilestoneBlastRadius([
      mtask({ title: "Add the dashboard header" }),
      mtask({ title: "Wire the empty state" }),
      mtask({ title: "Persist the last-viewed filter" }),
    ]);
    expect(b.radius).toBe("contained");
    expect(b.files).toBe(3);
    expect(b.reasons).toHaveLength(0);
  });

  test("a large-estimate task makes the milestone broad", () => {
    const b = classifyMilestoneBlastRadius([mtask(), mtask({ estimate: "large" })]);
    expect(b.radius).toBe("broad");
    expect(b.reasons.join(" ")).toContain("large-estimate");
  });

  test("a risk-sensitive TOPIC (the plan-time analogue of RISKY_PATH) is broad", () => {
    // Mirrors classifyBlastRadius's RISKY_PATH: auth/migration/infra work is broad
    // by consequence even before a diff exists.
    for (const title of [
      "Add OAuth login flow",
      "Run the users-table migration",
      "Wire the Stripe billing webhook",
      "Provision the deploy infrastructure",
    ]) {
      const b = classifyMilestoneBlastRadius([mtask({ title })]);
      expect(b.radius).toBe("broad");
      expect(b.reasons.join(" ")).toContain("risk-sensitive");
    }
  });

  test("a risky topic in a task's acceptance (not just its title) is broad", () => {
    const b = classifyMilestoneBlastRadius([
      mtask({ title: "Harden the API", acceptance: ["reads the auth token from the .env file"] }),
    ]);
    expect(b.radius).toBe("broad");
  });

  test("too many tasks is broad (plan-time FILE_LIMIT)", () => {
    const many = Array.from({ length: 12 }, (_, i) => mtask({ title: `Task ${i}` }));
    expect(classifyMilestoneBlastRadius(many).radius).toBe("broad");
  });
});

describe("isWithinBlastCeiling", () => {
  test("contained work always fits", () => {
    expect(isWithinBlastCeiling("contained", "contained")).toBe(true);
    expect(isWithinBlastCeiling("contained", "broad")).toBe(true);
  });
  test("broad work needs a broad ceiling", () => {
    expect(isWithinBlastCeiling("broad", "contained")).toBe(false);
    expect(isWithinBlastCeiling("broad", "broad")).toBe(true);
  });
});

describe("decideAutoLand", () => {
  const high = computeVerifierReport({ acceptance: met(2), qualityReport: quality("pass") }); // 1.0
  const medium = computeVerifierReport({
    acceptance: met(2),
    qualityReport: quality("skipped", 0),
  }); // 0.6

  test("high coverage + contained diff → land", () => {
    const d = decideAutoLand(high, classifyBlastRadius(SMALL_DIFF));
    expect(d.land).toBe(true);
  });

  test("medium coverage → hold (need high)", () => {
    const d = decideAutoLand(medium, classifyBlastRadius(SMALL_DIFF));
    expect(d.land).toBe(false);
    expect(d.reason).toContain("medium");
  });

  test("high coverage but broad diff → hold (default contained ceiling)", () => {
    const broad = classifyBlastRadius(
      `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+x`,
    );
    const d = decideAutoLand(high, broad);
    expect(d.land).toBe(false);
    expect(d.reason).toContain("blast radius");
  });

  test("broad diff lands when the project's maxBlastRadius ceiling is broad", () => {
    const broad = classifyBlastRadius(
      `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+x`,
    );
    // Operator opted the project into auto-landing broad diffs (still high cov).
    expect(decideAutoLand(high, broad, "broad").land).toBe(true);
    // …but coverage still gates: medium never lands regardless of ceiling.
    expect(decideAutoLand(medium, broad, "broad").land).toBe(false);
  });

  test("minLevel is honored — a trusted project can auto-land at medium", () => {
    const contained = classifyBlastRadius(SMALL_DIFF);
    // Default bar (high) holds medium…
    expect(decideAutoLand(medium, contained).land).toBe(false);
    // …but lowering the bar to medium lands it (the knob is no longer dead).
    const d = decideAutoLand(medium, contained, "contained", "medium");
    expect(d.land).toBe(true);
    // A lower bar never overrides blast radius, and never lands below-bar coverage.
    const none = computeVerifierReport({ acceptance: [], qualityReport: null }); // 0 / none
    expect(decideAutoLand(none, contained, "contained", "medium").land).toBe(false);
  });
});
