import { describe, expect, test } from "bun:test";
import { buildSkillRunDirective } from "../src/routers/skills.ts";

const skill = {
  name: "release",
  description: "Cut a release",
  filePath: "/proj/.claude/skills/release-dir/SKILL.md",
  body: "# Release\n\nRun `scripts/bump.sh`, then tag the commit.",
};

describe("buildSkillRunDirective", () => {
  test("injects the resolved SKILL.md body inline (no native-discovery reliance)", () => {
    const directive = buildSkillRunDirective(skill, ".claude/skills/release-dir");
    // Acceptance #1: the body rides in the prompt verbatim rather than the run
    // pointing the agent at a file to load via a CLI's native skill mechanism.
    expect(directive).toContain(skill.body);
    expect(directive).toContain("Run `scripts/bump.sh`");
  });

  test("names the skill and its resource directory for relative references", () => {
    const directive = buildSkillRunDirective(skill, ".claude/skills/release-dir");
    expect(directive).toContain("`release`");
    expect(directive).toContain(".claude/skills/release-dir/");
  });

  test("defers run-completion reporting to the run's own protocol", () => {
    const directive = buildSkillRunDirective(skill, ".claude/skills/release-dir");
    expect(directive).toMatch(/completion protocol/i);
  });
});
