import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import {
  confirmImportSpec,
  proposeImportSpec,
  type SpecDecomposition,
} from "../src/projects/import-spec.ts";

function makeTempConfig(): { config: FactoryConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-spec-import-test-"));
  const dbPath = path.join(root, "data.db");
  return {
    config: {
      port: 0,
      host: "127.0.0.1",
      auth: { token: "t-test" },
      workdir: root,
      worktreesRoot: path.join(root, "worktrees"),
      dbPath,
      maxConcurrentRuns: 1,
      defaultRunBudgetSeconds: 60,
      agentBudgetSeconds: 0,
      gitAuthor: { name: "Factory Test", email: "test@factory" },
      githubToken: null,
      factoryProjectId: null,
      vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
    },
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function seedSpecDecomposePrompt(dbPath: string) {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const promptText = readFileSync(path.join(repoRoot, "prompts/spec-decompose-v1.md"), "utf8");
  const db = createDb(dbPath);
  await db.insert(schema.prompts).values({
    id: createId(),
    promptKey: "spec-decompose-v1",
    version: 1,
    content: promptText,
    active: true,
    createdAt: Date.now(),
  });
}

const SAMPLE_SPEC = `# my-tracker — spec

## Goal

A small CLI that tracks the time I spend on each project. Reads from a
local SQLite database. Reports daily totals.

## Tasks

1. SQLite schema for time entries (start, end, project)
2. CLI: \`tracker start <project>\` and \`tracker stop\`
3. CLI: \`tracker today\` shows today's totals
4. Tests for the schema + CLI commands
`;

const FAKE_DECOMPOSITION_RESPONSE = JSON.stringify({
  title: "my-tracker",
  summary:
    "A CLI that tracks time spent per project, backed by SQLite, with a today-totals report.",
  tasks: [
    {
      title: "SQLite schema for time entries",
      estimate: "small",
      acceptance: ["Migration creates a `time_entries` table", "Columns: id, project, start, end"],
    },
    {
      title: "Implement `tracker start` and `tracker stop`",
      estimate: "medium",
      acceptance: ["start writes a new row with start=now", "stop sets end=now on the open row"],
    },
    {
      title: "Implement `tracker today` totals",
      estimate: "small",
      acceptance: ["Sums elapsed time per project for today", "Renders as table to stdout"],
    },
    {
      title: "Tests for schema + CLI",
      estimate: "small",
      acceptance: ["bun test passes for schema and CLI commands"],
    },
  ],
  unknowns: ["Output format — JSON vs. table — when not running in a TTY?"],
  risks: ["No timezone handling in v1; today is the operator's local day."],
  firstTaskNote:
    "Read docs/internal/SPEC.md, then start with the SQLite schema task. The CLI builds on top.",
});

describe("proposeImportSpec", () => {
  test("happy path: returns a coerced decomposition", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      await seedSpecDecomposePrompt(config.dbPath);
      const db = createDb(config.dbPath);

      const result = await proposeImportSpec(
        db,
        {
          title: "my-tracker",
          specMarkdown: SAMPLE_SPEC,
          ceremony: "personal",
          role: "owner",
        },
        {
          agentInvoker: async () => ({
            text: FAKE_DECOMPOSITION_RESPONSE,
            sessionId: "spec-sess-001",
            metrics: null,
          }),
        },
      );

      expect(result.decomposition.title).toBe("my-tracker");
      expect(result.decomposition.tasks).toHaveLength(4);
      expect(result.decomposition.tasks[0]?.estimate).toBe("small");
      expect(result.decomposition.tasks[0]?.acceptance.length).toBeGreaterThan(0);
      expect(result.decomposition.unknowns.length).toBeGreaterThan(0);
      expect(result.decomposition.firstTaskNote).toContain("SPEC.md");
    } finally {
      cleanup();
    }
  });

  test("rejects too-short specs", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      await seedSpecDecomposePrompt(config.dbPath);
      const db = createDb(config.dbPath);

      await expect(
        proposeImportSpec(
          db,
          {
            title: "x",
            specMarkdown: "tiny",
            ceremony: "tinker",
            role: "owner",
          },
          {
            agentInvoker: async () => {
              throw new Error("should not be invoked");
            },
          },
        ),
      ).rejects.toThrow(/spec too short/);
    } finally {
      cleanup();
    }
  });

  test("falls back to operator title when agent emits empty title", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      await seedSpecDecomposePrompt(config.dbPath);
      const db = createDb(config.dbPath);
      const result = await proposeImportSpec(
        db,
        {
          title: "fallback-name",
          specMarkdown: SAMPLE_SPEC,
          ceremony: "personal",
          role: "owner",
        },
        {
          agentInvoker: async () => ({
            text: JSON.stringify({
              title: "",
              summary: "x",
              tasks: [{ title: "t", estimate: "small", acceptance: [] }],
              unknowns: [],
              risks: [],
              firstTaskNote: "",
            }),
            sessionId: null,
            metrics: null,
          }),
        },
      );
      expect(result.decomposition.title).toBe("fallback-name");
    } finally {
      cleanup();
    }
  });
});

describe("confirmImportSpec", () => {
  test("happy path: bootstraps project, writes SPEC.md, seeds CLAUDE.md, creates tasks", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      const db = createDb(config.dbPath);
      const decomposition: SpecDecomposition = {
        title: "my-tracker",
        summary:
          "A CLI that tracks time spent per project, backed by SQLite, with a today-totals report.",
        tasks: [
          {
            title: "SQLite schema for time entries",
            estimate: "small",
            acceptance: ["Migration creates a `time_entries` table"],
          },
          {
            title: "Implement tracker start/stop",
            estimate: "medium",
            acceptance: ["start writes a new row with start=now"],
          },
        ],
        unknowns: ["Output format — JSON vs. table?"],
        risks: ["No timezone handling in v1."],
        firstTaskNote: "Read docs/internal/SPEC.md, then start with the schema task.",
      };

      const result = await confirmImportSpec(config, db, {
        title: "my-tracker",
        specMarkdown: SAMPLE_SPEC,
        ceremony: "personal",
        role: "owner",
        model: null,
        decomposition,
      });

      expect(result.projectId).toBeDefined();
      expect(result.slug).toBe("my-tracker");
      expect(result.specPath).toBe("docs/internal/SPEC.md");
      expect(result.taskIds).toHaveLength(2);

      // Spec is on disk verbatim.
      const specOnDisk = readFileSync(
        path.join(result.workdirPath, "docs", "internal", "SPEC.md"),
        "utf8",
      );
      expect(specOnDisk).toContain("my-tracker — spec");
      expect(specOnDisk).toContain("SQLite schema for time entries");

      // CLAUDE.md was seeded with a SPEC reference.
      const claudeMd = readFileSync(path.join(result.workdirPath, "CLAUDE.md"), "utf8");
      expect(claudeMd).toContain("docs/internal/SPEC.md");
      expect(claudeMd).toContain("First-task orientation");

      // Project row exists with auto-advance on, ceremony=personal.
      const project = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, result.projectId))
        .get();
      expect(project?.ceremony).toBe("personal");
      expect(project?.autoAdvance).toBe(true);
      expect(project?.role).toBe("owner");

      // Synthesized idea + greenlit decision exist.
      const ideaRows = await db.select().from(schema.ideas).all();
      expect(ideaRows).toHaveLength(1);
      expect(ideaRows[0]?.source).toBe("spec-import");
      expect(ideaRows[0]?.triagedAt).not.toBeNull();

      const decisionRows = await db.select().from(schema.decisions).all();
      expect(decisionRows).toHaveLength(1);
      expect(decisionRows[0]?.outcome).toBe("greenlit");
      expect(decisionRows[0]?.status).toBe("actioned");
      expect(decisionRows[0]?.rubricVersionId).toBeNull();

      // Bootstrap commit + spec commit are both there.
      expect(existsSync(path.join(result.workdirPath, ".git"))).toBe(true);
      expect(existsSync(path.join(result.workdirPath, ".factory", "work"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects too-short spec at confirm time", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      const db = createDb(config.dbPath);
      await expect(
        confirmImportSpec(config, db, {
          title: "x",
          specMarkdown: "tiny",
          ceremony: "tinker",
          role: "owner",
          model: null,
          decomposition: {
            title: "x",
            summary: "x",
            tasks: [{ title: "t", estimate: "small", acceptance: [] }],
            unknowns: [],
            risks: [],
            firstTaskNote: "",
          },
        }),
      ).rejects.toThrow(/spec too short/);
    } finally {
      cleanup();
    }
  });
});
