import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import { prependOperatorContext, wrapPrompt } from "../src/workers/factory-status.ts";

/**
 * Cover the operator-answers-in-retry path end-to-end at the data layer.
 * The PWA wires comments → approve; this test replicates the same DB
 * sequence the router runs (insert decision, insert operator comments,
 * gather thread, render context, persist on the new run row) so we catch
 * regressions in the schema, the helper, or the prompt wrap separately.
 */

function setupHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-blocked-retry-test-"));
  const dbPath = path.join(root, "data.db");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  mkdirSync(path.join(root, "worktrees"), { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function seedProject(db: ReturnType<typeof createDb>): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: "blocked-retry-demo",
      name: "demo",
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath: "/tmp/blocked-retry-demo",
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return id;
}

describe("prependOperatorContext", () => {
  test("prepends caller-supplied context above the prompt with a separator", () => {
    const wrapped = wrapPrompt("do the thing", "collaborative");
    // Helper is generic glue — caller owns the section header. Verifies that
    // an arbitrary header survives as the leading line and the original
    // prompt rides intact below the `---` separator.
    const ctx = "## Operator notes\n\nUse sqlite-vec, not pgvector.";
    const out = prependOperatorContext(wrapped, ctx);
    expect(out.startsWith("## Operator notes")).toBe(true);
    expect(out).toContain("Use sqlite-vec, not pgvector.");
    expect(out).toContain("\n\n---\n\n");
    // Original prompt must still ride at the bottom — the wrap-up footer
    // is the contract that keeps the agent honest about completion.
    expect(out).toContain("do the thing");
    expect(out.indexOf("## Operator notes")).toBeLessThan(out.indexOf("do the thing"));
  });

  test("returns the prompt unchanged when operator context is empty", () => {
    const wrapped = wrapPrompt("do the thing");
    expect(prependOperatorContext(wrapped, "")).toBe(wrapped);
    expect(prependOperatorContext(wrapped, "   \n  ")).toBe(wrapped);
  });
});

describe("blocked_run retry · operator-context flow", () => {
  test("operator comments fold into the new run row's operatorContext", async () => {
    const h = setupHarness();
    try {
      const projectId = seedProject(h.db);
      const sourceRunId = createId();
      const sourceBranch = `factory/run-${sourceRunId}`;
      const now = Date.now();

      h.db
        .insert(schema.runs)
        .values({
          id: sourceRunId,
          projectId,
          taskId: "task-007",
          status: "blocked",
          agentName: "claude-code",
          branch: sourceBranch,
          worktreePath: `/tmp/wt/${sourceRunId}`,
          startedAt: now - 60_000,
          endedAt: now - 1_000,
          budgetSeconds: 0,
          summary: "Stuck on M21 corpus location",
          blockerQuestions: JSON.stringify([
            "Has the M21 raw export been placed under corpus/m21/raw/?",
          ]),
        })
        .run();

      const decisionId = createId();
      h.db
        .insert(schema.decisions)
        .values({
          id: decisionId,
          kind: "blocked_run",
          projectId,
          outcome: "blocked",
          payload: {
            runId: sourceRunId,
            taskId: "task-007",
            summary: "Stuck on M21 corpus location",
            questions: ["Has the M21 raw export been placed under corpus/m21/raw/?"],
            branch: sourceBranch,
          },
          status: "pending",
          createdAt: now,
        })
        .run();

      // Two operator replies, one agent reply (which must be ignored when
      // building operator context — the agent's "thinking" placeholder
      // should never leak into the next run's prompt).
      h.db
        .insert(schema.decisionComments)
        .values([
          {
            id: createId(),
            decisionId,
            role: "operator",
            body: "yes — see corpus/m21/raw/2026-04 export.zip. unzip and treat the .pdf set as canonical.",
            createdAt: now + 1_000,
          },
          {
            id: createId(),
            decisionId,
            role: "agent",
            body: "(this should not be folded into the retry prompt)",
            createdAt: now + 2_000,
          },
          {
            id: createId(),
            decisionId,
            role: "operator",
            body: "skip the OCR fallback for now. flag any chunks <200 tokens.",
            createdAt: now + 3_000,
          },
        ])
        .run();

      // Mirror what decisions.action does on approve(blocked_run): gather
      // operator-only comments, render an operator-context block, persist
      // it on the new run row. We don't call submitRun here because that
      // path would require the full WorkerPool/RunRegistry/EventBus dep
      // wiring; the contract under test is "the new row carries the
      // operator's answers verbatim, in chronological order, agent
      // comments excluded."
      const thread = h.db
        .select()
        .from(schema.decisionComments)
        .where(eq(schema.decisionComments.decisionId, decisionId))
        .orderBy(asc(schema.decisionComments.createdAt))
        .all();
      const operatorReplies = thread.filter((c) => c.role === "operator");
      // Mirror `renderBlockedRunOperatorContext` from decisions.ts: the
      // section header is the caller's responsibility under the new
      // `prependOperatorContext` contract; the helper is just glue.
      const replyBlocks = operatorReplies
        .map(
          (c) => `### Operator reply · ${new Date(c.createdAt).toISOString()}\n\n${c.body.trim()}`,
        )
        .join("\n\n");
      const operatorContext = `## Operator notes (from prior blocked run)\n\n${replyBlocks}`;

      const newRunId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: newRunId,
          projectId,
          taskId: "task-007",
          status: "queued",
          agentName: "claude-code",
          branch: `factory/run-${newRunId}`,
          worktreePath: `/tmp/wt/${newRunId}`,
          startedAt: now + 4_000,
          budgetSeconds: 0,
          baseRef: sourceBranch,
          operatorContext,
        })
        .run();

      const newRun = h.db.select().from(schema.runs).where(eq(schema.runs.id, newRunId)).get();
      expect(newRun).toBeDefined();
      expect(newRun?.operatorContext).toContain("corpus/m21/raw/2026-04 export.zip");
      expect(newRun?.operatorContext).toContain("skip the OCR fallback");
      expect(newRun?.operatorContext).not.toContain("this should not be folded");
      // Chronological order — first operator reply must come before the second.
      const idxFirst = newRun?.operatorContext?.indexOf("corpus/m21/raw") ?? -1;
      const idxSecond = newRun?.operatorContext?.indexOf("OCR fallback") ?? -1;
      expect(idxFirst).toBeGreaterThanOrEqual(0);
      expect(idxSecond).toBeGreaterThan(idxFirst);

      // The runner reads `row.operatorContext` and prepends it via the
      // factory-status helper. Verify the composed prompt has both layers.
      const wrapped = wrapPrompt("Run the M21 corpus build.", "collaborative");
      const finalPrompt = prependOperatorContext(wrapped, newRun?.operatorContext ?? "");
      expect(finalPrompt).toMatch(/^## Operator notes \(from prior blocked run\)/);
      expect(finalPrompt).toContain("corpus/m21/raw/2026-04 export.zip");
      expect(finalPrompt).toContain("Run the M21 corpus build.");
    } finally {
      h.cleanup();
    }
  });
});
