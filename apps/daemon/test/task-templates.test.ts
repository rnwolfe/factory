import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema, type TaskTemplateDraft } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { applyTaskTemplateFreeze, loadActiveTemplate } from "../src/plans/apply-task-template.ts";
import {
  InstantiateTemplateError,
  instantiateTaskTemplate,
} from "../src/task-templates/instantiate.ts";

interface Harness {
  db: ReturnType<typeof createDb>;
  workdirPath: string;
  cleanup: () => void;
}

function mkHarness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-tpl-test-"));
  const dbPath = path.join(dir, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const workdirPath = path.join(dir, "project");
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  // Tasks's id allocator scans the directory for existing .md files; an
  // empty dir produces task-001 on createTask.
  return {
    db,
    workdirPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function seedProject(
  db: ReturnType<typeof createDb>,
  workdirPath: string,
): Promise<{ projectId: string }> {
  const projectId = createId();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "test-project",
    name: "Test Project",
    workdirPath,
    createdAt: now,
    lastActivityAt: now,
    ceremony: "tinker",
    role: "owner",
  });
  return { projectId };
}

const SIMPLE_DRAFT: TaskTemplateDraft = {
  kind: "task_template",
  name: "Release Notes Flow",
  description: "Add a release-notes/what's-new flow",
  titlePattern: "Add release-notes flow to {projectName}",
  labels: ["feature", "ux"],
  priority: "med",
  estimate: "medium",
  variables: [
    {
      key: "channel_name",
      label: "Channel name",
      description: "Where users see the notification",
      required: false,
      default: "what's new",
    },
  ],
  sections: [
    {
      heading: "Acceptance",
      kind: "static",
      body: "- [ ] {channel_name} notification surfaces on first view after upgrade\n- [ ] Operator can re-view past entries\n- [ ] localStorage gate prevents repeat notifications",
    },
    {
      heading: "Notes",
      kind: "static",
      body: "Match the existing aesthetic of {projectName}; reuse {projectSlug}'s shell components.",
    },
  ],
};

describe("applyTaskTemplateFreeze", () => {
  test("creates a new row when slug doesn't exist", async () => {
    const h = mkHarness();
    try {
      const planId = createId();
      const result = await applyTaskTemplateFreeze({
        db: h.db,
        draft: SIMPLE_DRAFT,
        planId,
      });
      expect(result.created).toBe(true);
      expect(result.slug).toBe("release-notes-flow");
      const row = await h.db
        .select()
        .from(schema.taskTemplates)
        .where(eq(schema.taskTemplates.id, result.templateId))
        .get();
      expect(row).toBeDefined();
      expect(row?.slug).toBe("release-notes-flow");
      expect(row?.name).toBe("Release Notes Flow");
    } finally {
      h.cleanup();
    }
  });

  test("updates existing slug in place when re-frozen", async () => {
    const h = mkHarness();
    try {
      const planId1 = createId();
      const first = await applyTaskTemplateFreeze({
        db: h.db,
        draft: SIMPLE_DRAFT,
        planId: planId1,
      });
      expect(first.created).toBe(true);

      const planId2 = createId();
      const updatedDraft: TaskTemplateDraft = {
        ...SIMPLE_DRAFT,
        description: "Updated description",
      };
      const second = await applyTaskTemplateFreeze({
        db: h.db,
        draft: updatedDraft,
        planId: planId2,
      });
      expect(second.created).toBe(false);
      expect(second.templateId).toBe(first.templateId);

      const reloaded = await loadActiveTemplate(h.db, "release-notes-flow");
      expect(reloaded?.draft.description).toBe("Updated description");
    } finally {
      h.cleanup();
    }
  });

  test("rejects drafts with the wrong kind", async () => {
    const h = mkHarness();
    try {
      await expect(
        applyTaskTemplateFreeze({
          db: h.db,
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
          draft: { kind: "task_plan" } as any,
          planId: createId(),
        }),
      ).rejects.toThrow();
    } finally {
      h.cleanup();
    }
  });

  test("rejects drafts with no name", async () => {
    const h = mkHarness();
    try {
      await expect(
        applyTaskTemplateFreeze({
          db: h.db,
          draft: { ...SIMPLE_DRAFT, name: "" },
          planId: createId(),
        }),
      ).rejects.toThrow();
    } finally {
      h.cleanup();
    }
  });
});

describe("instantiateTaskTemplate", () => {
  test("static-only render: produces a task file with substituted vars", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      const planId = createId();
      await applyTaskTemplateFreeze({ db: h.db, draft: SIMPLE_DRAFT, planId });

      const result = await instantiateTaskTemplate({
        db: h.db,
        templateSlug: "release-notes-flow",
        projectId,
        variables: { channel_name: "Release Hub" },
        renderWithAgent: false, // pure static
      });

      expect(result.taskId).toMatch(/^task-/);
      expect(result.title).toBe("Add release-notes flow to Test Project");
      expect(result.bodyPreview).toContain("Release Hub notification");
      expect(result.bodyPreview).toContain("Test Project");
      expect(result.bodyPreview).toContain("test-project");
      // Verify the file actually landed.
      const taskDir = path.join(h.workdirPath, ".factory", "work");
      const files = readdirOrEmpty(taskDir);
      expect(result.mode).toBe("task");
      expect(files.some((f) => f.startsWith(result.taskId ?? " "))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  // confirmInInbox templates (release) land a release_proposal decision instead
  // of creating a task. renderWithAgent:false skips all model calls, so an
  // agent-resolved variable falls back to its default/blank — letting us test
  // the proposal plumbing without spawning the CLI.
  const RELEASE_DRAFT: TaskTemplateDraft = {
    kind: "task_template",
    name: "Release",
    description: "Cut a release",
    titlePattern: "Release {projectName} {version}",
    labels: ["release"],
    priority: "med",
    estimate: "small",
    confirmInInbox: true,
    variables: [
      {
        key: "version",
        label: "Version",
        description: "Next version",
        required: false,
        default: null,
        resolver: { kind: "agent", prompt: "Determine the next version." },
      },
    ],
    sections: [{ heading: "Recipe", kind: "static", body: "Cut release {version}." }],
  };

  test("confirmInInbox lands a release_proposal decision instead of a task", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      await applyTaskTemplateFreeze({ db: h.db, draft: RELEASE_DRAFT, planId: createId() });

      const result = await instantiateTaskTemplate({
        db: h.db,
        templateSlug: "release",
        projectId,
        variables: {}, // no operator version → model would resolve, but agent skipped
        renderWithAgent: false,
      });

      expect(result.mode).toBe("proposal");
      expect(result.decisionId).toBeDefined();
      expect(result.taskId).toBeUndefined();
      // No task file was written.
      expect(readdirOrEmpty(path.join(h.workdirPath, ".factory", "work")).length).toBe(0);
      // The decision row exists with the right kind + projectId.
      const decision = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, result.decisionId ?? ""))
        .get();
      expect(decision?.kind).toBe("release_proposal");
      expect(decision?.projectId).toBe(projectId);
      expect(decision?.status).toBe("pending");
    } finally {
      h.cleanup();
    }
  });

  test("operator-supplied value overrides an agent-resolved variable", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      await applyTaskTemplateFreeze({ db: h.db, draft: RELEASE_DRAFT, planId: createId() });

      const result = await instantiateTaskTemplate({
        db: h.db,
        templateSlug: "release",
        projectId,
        variables: { version: "v9.9.9" }, // operator pins it; resolver must not run
        renderWithAgent: true, // even with the agent enabled, the operator value wins
      });

      expect(result.mode).toBe("proposal");
      expect(result.resolvedVariables.version).toBe("v9.9.9");
      expect(result.title).toBe("Release Test Project v9.9.9");
    } finally {
      h.cleanup();
    }
  });

  test("uses variable default when operator omits the value", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      await applyTaskTemplateFreeze({ db: h.db, draft: SIMPLE_DRAFT, planId: createId() });
      const result = await instantiateTaskTemplate({
        db: h.db,
        templateSlug: "release-notes-flow",
        projectId,
        variables: {}, // no input → default "what's new" should apply
        renderWithAgent: false,
      });
      expect(result.bodyPreview).toContain("what's new notification");
    } finally {
      h.cleanup();
    }
  });

  test("throws on missing required variable with no default", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      const required: TaskTemplateDraft = {
        ...SIMPLE_DRAFT,
        name: "Strict",
        variables: [
          {
            key: "missing_thing",
            label: "Missing thing",
            description: "required, no default",
            required: true,
            default: null,
          },
        ],
      };
      await applyTaskTemplateFreeze({ db: h.db, draft: required, planId: createId() });

      await expect(
        instantiateTaskTemplate({
          db: h.db,
          templateSlug: "strict",
          projectId,
          variables: {},
          renderWithAgent: false,
        }),
      ).rejects.toBeInstanceOf(InstantiateTemplateError);
    } finally {
      h.cleanup();
    }
  });

  test("agent sections fall back to placeholder when renderWithAgent=false", async () => {
    const h = mkHarness();
    try {
      const { projectId } = await seedProject(h.db, h.workdirPath);
      const withAgent: TaskTemplateDraft = {
        ...SIMPLE_DRAFT,
        name: "With Agent",
        sections: [
          ...SIMPLE_DRAFT.sections,
          {
            heading: "Implementation",
            kind: "agent",
            body: "Look at the project's component structure and propose the right component names.",
          },
        ],
      };
      await applyTaskTemplateFreeze({ db: h.db, draft: withAgent, planId: createId() });

      const result = await instantiateTaskTemplate({
        db: h.db,
        templateSlug: "with-agent",
        projectId,
        variables: {},
        renderWithAgent: false,
      });
      const implSection = result.sections.find((s) => s.heading === "Implementation");
      expect(implSection?.kind).toBe("agent");
      expect(implSection?.agentRendered).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

function readdirOrEmpty(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // biome-ignore lint/style/useNodejsImportProtocol: bun runtime
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readdirSync(dir);
}
