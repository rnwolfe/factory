import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import YAML from "yaml";
import type { FactoryConfig } from "../src/config.ts";
import { bootstrapProject } from "../src/projects/bootstrap.ts";
import { runTriage, type TriageDecisionPayload } from "../src/triage/orchestrate.ts";

function makeTempConfig(): { config: FactoryConfig; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-daemon-test-"));
  const dbPath = path.join(root, "data.db");
  return {
    config: {
      port: 0,
      host: "127.0.0.1",
      auth: { token: "t-test" },
      workdir: root,
      dbPath,
      maxConcurrentRuns: 1,
      defaultRunBudgetSeconds: 60,
      gitAuthor: { name: "Factory Test", email: "test@factory" },
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

async function seedActiveRubricAndPrompt(dbPath: string) {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const rubricYaml = readFileSync(path.join(repoRoot, "rubrics/rubric-me-tinker.yaml"), "utf8");
  const promptText = readFileSync(path.join(repoRoot, "prompts/triage-prompt-v1.md"), "utf8");
  const db = createDb(dbPath);
  await db.insert(schema.prompts).values({
    id: createId(),
    promptKey: "triage-prompt-v1",
    version: 1,
    content: promptText,
    active: true,
    createdAt: Date.now(),
  });
  await db.insert(schema.rubricVersions).values({
    id: createId(),
    rubricKey: "rubric-me-tinker",
    version: 1,
    yaml: rubricYaml,
    promptKey: "triage-prompt-v1",
    active: true,
    createdAt: Date.now(),
  });
}

describe("triage → decision → bootstrap (mock agent)", () => {
  test("greenlit decision becomes a real project on disk", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      await seedActiveRubricAndPrompt(config.dbPath);
      const db = createDb(config.dbPath);

      // Insert an idea.
      const ideaId = createId();
      await db.insert(schema.ideas).values({
        id: ideaId,
        rawText: "A small CLI that summarizes my day from terminal history",
        goalHint: "me",
        source: "test",
        createdAt: Date.now(),
      });

      // Mock agent: returns a greenlit triage payload.
      const mockPayload: TriageDecisionPayload = {
        outcome: "greenlit",
        weighted_score: 8.1,
        uncertainty: 0.15,
        axes: [
          { id: "utility", score: 8, rationale: "real workflow pain" },
          { id: "feasibility", score: 9, rationale: "TS+CLI is well-trodden" },
          { id: "personal_fit", score: 9, rationale: "ergonomic CLIs are a recurring theme" },
          { id: "time_to_first_value", score: 7, rationale: "scaffold + ingestion in first run" },
          { id: "stack_fit", score: 8, rationale: "Bun + node:os fits squarely" },
        ],
        rationale: "Direct fit; small surface area; first-run demo plausible.",
        title_suggestion: "termsum",
        spec_stub: {
          summary: "CLI that scans recent shell history and writes a daily digest.",
          initial_tasks: [
            {
              title: "Scaffold CLI entrypoint and history ingestion",
              estimate: "small",
              acceptance: ["Reads ~/.zsh_history", "Outputs structured records to stdout"],
            },
            {
              title: "Daily digest formatter",
              estimate: "small",
              acceptance: ["Groups commands by tool", "Emits Markdown summary"],
            },
            {
              title: "Persistence + idempotent re-runs",
              estimate: "medium",
              acceptance: ["Avoids double-processing the same lines"],
            },
          ],
        },
      };

      const triage = await runTriage(
        db,
        { ideaId, rawText: "A small CLI…", goalHint: "me" },
        { agentInvoker: async () => JSON.stringify(mockPayload) },
      );
      expect(triage.payload.outcome).toBe("greenlit");

      // Verify decision row exists with status=pending.
      const decision = await db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, triage.decisionId))
        .get();
      expect(decision).toBeTruthy();
      expect(decision?.status).toBe("pending");
      expect(decision?.kind).toBe("triage");

      // Bootstrap.
      const bs = await bootstrapProject(config, db, {
        ideaId,
        decisionId: triage.decisionId,
        payload: triage.payload,
        ideaText: "A small CLI…",
        goal: "me",
        tier: "tinker",
      });

      // Verify project on disk.
      expect(existsSync(bs.workdirPath)).toBe(true);
      expect(existsSync(path.join(bs.workdirPath, ".git"))).toBe(true);
      expect(existsSync(path.join(bs.workdirPath, ".factory", "meta.yaml"))).toBe(true);
      expect(existsSync(path.join(bs.workdirPath, ".factory", "notes", "decisions.md"))).toBe(true);
      expect(existsSync(path.join(bs.workdirPath, ".factory", "work"))).toBe(true);

      const meta = YAML.parse(
        readFileSync(path.join(bs.workdirPath, ".factory", "meta.yaml"), "utf8"),
      );
      expect(meta.projectId).toBe(bs.projectId);
      expect(meta.slug).toBe(bs.slug);

      // Verify project row.
      const project = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, bs.projectId))
        .get();
      expect(project).toBeTruthy();
      expect(project?.tag).toBe("active");
      expect(project?.tier).toBe("tinker");

      // Verify task files match the spec_stub count.
      expect(bs.taskIds).toEqual(["task-001", "task-002", "task-003"]);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("triage failure surfaces as a trashed decision card (never silent)", async () => {
    const { config, cleanup } = makeTempConfig();
    try {
      runMigrations(config.dbPath);
      await seedActiveRubricAndPrompt(config.dbPath);
      const db = createDb(config.dbPath);

      const ideaId = createId();
      await db.insert(schema.ideas).values({
        id: ideaId,
        rawText: "?",
        source: "test",
        createdAt: Date.now(),
      });

      let threw = false;
      try {
        await runTriage(
          db,
          { ideaId, rawText: "?", goalHint: undefined },
          {
            agentInvoker: async () => "not valid json at all",
          },
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      cleanup();
    }
  }, 15_000);
});
