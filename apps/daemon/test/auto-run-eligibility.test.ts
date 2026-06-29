import { describe, expect, test } from "bun:test";
import { type AutoRunCandidate, isAutoRunEligible } from "../src/autonomy/auto-run.ts";
import { type AutonomyConfig, BUILTIN_AUTONOMY } from "../src/autonomy/config.ts";

/** A config with auto-run turned on for the given class (everything else default). */
function enabledFor(cls: string, over: Partial<AutonomyConfig["autorun"]> = {}): AutonomyConfig {
  return {
    ...BUILTIN_AUTONOMY,
    autorun: { ...BUILTIN_AUTONOMY.autorun, enabled: true, classes: [cls], ...over },
  };
}

const groom: AutoRunCandidate = {
  proposalClass: "groom-backlog",
  isCodeRun: false,
  projectAutonomyMode: "autonomous",
  hasQualityGate: false,
  runsThisTick: 0,
};

describe("isAutoRunEligible", () => {
  test("groom-backlog passes all universal gates (no quality requirement, it's not a code run)", () => {
    expect(isAutoRunEligible(groom, enabledFor("groom-backlog")).eligible).toBe(true);
  });

  test("default config (disabled, empty allow-list) is ineligible", () => {
    expect(isAutoRunEligible(groom, BUILTIN_AUTONOMY).eligible).toBe(false);
  });

  test("emergency stop overrides everything", () => {
    const cfg = enabledFor("groom-backlog", { emergencyStop: true });
    const v = isAutoRunEligible(groom, cfg);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("emergency stop");
  });

  test("a non-top-rung project is ineligible", () => {
    const v = isAutoRunEligible(
      { ...groom, projectAutonomyMode: "collaborative" },
      enabledFor("groom-backlog"),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("top trust rung");
  });

  test("a class outside the allow-list is ineligible", () => {
    const v = isAutoRunEligible(
      { ...groom, proposalClass: "adopt-as-task" },
      enabledFor("groom-backlog"),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("allow-list");
  });

  test("per-tick budget exhaustion is ineligible", () => {
    const cfg = enabledFor("groom-backlog", { maxPerTick: 2 });
    expect(isAutoRunEligible({ ...groom, runsThisTick: 1 }, cfg).eligible).toBe(true);
    expect(isAutoRunEligible({ ...groom, runsThisTick: 2 }, cfg).eligible).toBe(false);
  });

  test("a CODE run without a quality gate is ineligible; with one it passes", () => {
    const codeRun: AutoRunCandidate = {
      proposalClass: "adopt-as-task",
      isCodeRun: true,
      projectAutonomyMode: "autonomous",
      hasQualityGate: false,
      runsThisTick: 0,
    };
    const cfg = enabledFor("adopt-as-task");
    const v = isAutoRunEligible(codeRun, cfg);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("quality gate");
    expect(isAutoRunEligible({ ...codeRun, hasQualityGate: true }, cfg).eligible).toBe(true);
  });

  test("requireQualityGate=false lets a code run through without quality.yaml", () => {
    const codeRun: AutoRunCandidate = {
      proposalClass: "adopt-as-task",
      isCodeRun: true,
      projectAutonomyMode: "autonomous",
      hasQualityGate: false,
      runsThisTick: 0,
    };
    const cfg = enabledFor("adopt-as-task", { requireQualityGate: false });
    expect(isAutoRunEligible(codeRun, cfg).eligible).toBe(true);
  });
});
