import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import type { FactoryConfig } from "../src/config.ts";
import { coerceMilestones, renderMilestoneRoadmap } from "../src/projects/import-spec.ts";
import {
  confirmMilestone,
  type MilestoneProject,
  proposeMilestone,
  renderExistingTasks,
} from "../src/projects/milestone-decompose.ts";
import { createTask, listTasks } from "../src/projects/tasks.ts";

function setupWorkdir(withSpec: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "factory-milestone-"));
  mkdirSync(path.join(root, ".factory", "work"), { recursive: true });
  if (withSpec) {
    mkdirSync(path.join(root, "docs", "internal"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "internal", "SPEC.md"),
      "# Spec\n\n## 13. Milestone-gated build order\n- M0 — spike\n- M1 — onboarding\n",
      "utf8",
    );
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-milestone-db-"));
  const dbPath = path.join(dir, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  db.insert(schema.prompts)
    .values({
      id: "p-milestone",
      promptKey: "spec-decompose-milestone-v1",
      version: 1,
      content:
        "ceremony={{INTENT_CEREMONY}} target={{TARGET_MILESTONE}}\nEXISTING:\n{{EXISTING_TASKS}}\nSPEC:\n{{SPEC_MARKDOWN}}",
      active: true,
      createdAt: Date.now(),
    })
    .run();
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONFIG = { gitAuthor: { name: "T", email: "t@t" } } as unknown as FactoryConfig;

describe("coerceMilestones", () => {
  test("keeps well-formed milestones, drops idless ones, defaults fields", () => {
    const out = coerceMilestones([
      { id: "M0", title: "Spike", goal: "one slice", killGate: "faithful?" },
      { title: "no id" },
      { id: "M1" },
    ]);
    expect(out).toEqual([
      { id: "M0", title: "Spike", goal: "one slice", killGate: "faithful?" },
      { id: "M1", title: "", goal: "" },
    ]);
  });
  test("non-array degrades to []", () => {
    expect(coerceMilestones(undefined)).toEqual([]);
    expect(coerceMilestones("nope")).toEqual([]);
  });
});

describe("renderMilestoneRoadmap", () => {
  test("renders a section for a roadmap, empty string for none", () => {
    expect(renderMilestoneRoadmap([], "docs/internal/SPEC.md")).toBe("");
    const md = renderMilestoneRoadmap(
      [{ id: "M0", title: "Spike", goal: "slice", killGate: "faithful?" }],
      "docs/internal/SPEC.md",
    );
    expect(md).toContain("## Milestone roadmap");
    expect(md).toContain("**M0** — Spike: slice");
    expect(md).toContain("kill-gate:");
  });
});

describe("renderExistingTasks", () => {
  test("groups by milestone with status", async () => {
    const { root, cleanup } = setupWorkdir(false);
    try {
      await createTask({ workdirPath: root }, { title: "Done thing", body: "x", milestone: "M0" });
      const tasks = await listTasks({ workdirPath: root });
      const digest = renderExistingTasks(tasks);
      expect(digest).toContain("### M0");
      expect(digest).toContain("Done thing");
    } finally {
      cleanup();
    }
  });
});

describe("proposeMilestone", () => {
  test("decomposes the next milestone from SPEC.md via the agent seam", async () => {
    const wd = setupWorkdir(true);
    const d = seedDb();
    try {
      const project: MilestoneProject = {
        id: "proj1",
        workdirPath: wd.root,
        ceremony: "production",
        agent: null,
        taskBackend: "file",
      };
      const agentInvoker = async (prompt: string) => {
        expect(prompt).toContain("Milestone-gated build order"); // SPEC was injected
        expect(prompt).toContain("(next)"); // no target → infer
        return {
          text: JSON.stringify({
            milestone: "M1",
            summary: "onboarding + ideation",
            tasks: [
              { title: "Build the router", estimate: "medium", acceptance: ["seed → premise"] },
            ],
            unknowns: [],
            risks: [],
            firstTaskNote: "read §5",
            roadmap: [
              { id: "M0", title: "Spike", goal: "one slice" },
              { id: "M1", title: "Onboarding", goal: "ideation" },
            ],
          }),
          sessionId: null,
          metrics: null,
        };
      };
      const res = await proposeMilestone(d.db, project, {}, { agentInvoker });
      expect(res.decomposition.milestone).toBe("M1");
      expect(res.decomposition.tasks).toHaveLength(1);
      expect(res.decomposition.roadmap.map((m) => m.id)).toEqual(["M0", "M1"]);
    } finally {
      wd.cleanup();
      d.cleanup();
    }
  });

  test("throws when the project has no imported spec", async () => {
    const wd = setupWorkdir(false);
    const d = seedDb();
    try {
      const project: MilestoneProject = {
        id: "proj1",
        workdirPath: wd.root,
        ceremony: "personal",
        agent: null,
        taskBackend: "file",
      };
      await expect(
        proposeMilestone(
          d.db,
          project,
          {},
          { agentInvoker: async () => ({ text: "{}", sessionId: null, metrics: null }) },
        ),
      ).rejects.toThrow("no imported spec");
    } finally {
      wd.cleanup();
      d.cleanup();
    }
  });
});

describe("confirmMilestone", () => {
  test("creates tasks tagged with the milestone + provenance (file backend)", async () => {
    const wd = setupWorkdir(true);
    try {
      const project: MilestoneProject = { id: "proj1", workdirPath: wd.root, taskBackend: "file" };
      const res = await confirmMilestone(CONFIG, project, {
        milestone: "M1",
        tasks: [
          { title: "Build the router", estimate: "medium", acceptance: ["seed → premise"] },
          { title: "Wire the gates", estimate: "small", acceptance: [] },
        ],
      });
      expect(res.taskIds).toHaveLength(2);

      const tasks = await listTasks(project);
      expect(tasks).toHaveLength(2);
      for (const t of tasks) {
        expect(t.frontmatter.milestone).toBe("M1");
        expect(t.frontmatter.sourceMilestone).toBe("M1");
        expect(t.frontmatter.labels).toContain("milestone-task");
      }
    } finally {
      wd.cleanup();
    }
  });
});
