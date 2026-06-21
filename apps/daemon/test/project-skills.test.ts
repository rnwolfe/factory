import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjectSkills, parseProjectSkill } from "../src/projects/project-skills.ts";

function mkTemp(): string {
  return mkdtempSync(path.join(tmpdir(), "factory-project-skills-"));
}

function writeSkill(projectPath: string, name: string, contents: string): void {
  const dir = path.join(projectPath, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), contents, "utf8");
}

describe("parseProjectSkill", () => {
  test("reads name + description from frontmatter", () => {
    const skill = parseProjectSkill(
      "---\nname: release\ndescription: Cut a release\n---\nbody\n",
      "/p/.claude/skills/release/SKILL.md",
      "release",
    );
    expect(skill).toEqual({
      name: "release",
      description: "Cut a release",
      filePath: "/p/.claude/skills/release/SKILL.md",
    });
  });

  test("falls back to directory name when frontmatter omits name", () => {
    const skill = parseProjectSkill("---\ndescription: x\n---\n", "/p/SKILL.md", "ux-audit");
    expect(skill?.name).toBe("ux-audit");
    expect(skill?.description).toBe("x");
  });

  test("returns empty description when omitted", () => {
    const skill = parseProjectSkill("---\nname: foo\n---\n", "/p/SKILL.md", "foo");
    expect(skill?.description).toBe("");
  });

  test("returns null without a frontmatter block", () => {
    expect(parseProjectSkill("# no frontmatter\n", "/p/SKILL.md", "foo")).toBeNull();
  });
});

describe("listProjectSkills", () => {
  test("returns [] when .claude/skills is absent", async () => {
    const dir = mkTemp();
    try {
      expect(await listProjectSkills(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns [] when .claude/skills has no SKILL.md files", async () => {
    const dir = mkTemp();
    try {
      mkdirSync(path.join(dir, ".claude", "skills", "empty"), { recursive: true });
      expect(await listProjectSkills(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists skills sorted by name and skips malformed ones", async () => {
    const dir = mkTemp();
    try {
      writeSkill(dir, "zed", "---\nname: zed\ndescription: last\n---\n");
      writeSkill(dir, "alpha", "---\nname: alpha\ndescription: first\n---\n");
      writeSkill(dir, "broken", "no frontmatter here\n");
      const skills = await listProjectSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(["alpha", "zed"]);
      expect(skills[0]?.description).toBe("first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores non-directory entries under .claude/skills", async () => {
    const dir = mkTemp();
    try {
      mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
      writeFileSync(path.join(dir, ".claude", "skills", "README.md"), "loose file\n", "utf8");
      writeSkill(dir, "real", "---\nname: real\ndescription: ok\n---\n");
      const skills = await listProjectSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(["real"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
