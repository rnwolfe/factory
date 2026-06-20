import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { interventionLog } from "../src/interventions/log.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-intervention-log-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id: "p1",
      slug: "p1",
      name: "P1",
      ceremony: "tinker",
      workdirPath: path.join(root, "p1"),
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  const decisionId = createId();
  db.insert(schema.decisions)
    .values({
      id: decisionId,
      kind: "blocked_run",
      projectId: "p1",
      outcome: "blocked",
      payload: {},
      status: "pending",
      createdAt: now,
    })
    .run();
  return { db, decisionId, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("InterventionLog — dialog chain (task-049)", () => {
  test("records a dialog, then closes it by retry run with the outcome", async () => {
    const h = setup();
    try {
      const log = interventionLog(h.db);
      const id = await log.recordDialog({
        decisionId: h.decisionId,
        projectId: "p1",
        sourceRunId: "run-src",
        worktreePath: "/wt/src",
        tmuxSessionName: "sess-src",
        blockerQuestions: ["Where is the API key?"],
        operatorReply: "Use ~/.ai_gateway_api_key",
        retryRunId: "run-retry",
      });
      expect(id).toBeTruthy();

      const open = await log.listForDecision(h.decisionId);
      expect(open.length).toBe(1);
      expect(open[0]?.type).toBe("dialog");
      expect(open[0]?.status).toBe("active");
      expect(open[0]?.blockerQuestions).toEqual(["Where is the API key?"]);
      expect(open[0]?.retryRunId).toBe("run-retry");

      // A retry resolving closes the matching dialog with its terminal status.
      await log.closeDialogForRetry("run-retry", "completed");
      const closed = await log.listForDecision(h.decisionId);
      expect(closed[0]?.status).toBe("resolved");
      expect(closed[0]?.outcome).toBe("completed");
      expect(closed[0]?.endedAt).not.toBeNull();

      // listForRun keys off the source run.
      const byRun = await log.listForRun("run-src");
      expect(byRun.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("closeDialogForRetry is a no-op when no dialog references the run", async () => {
    const h = setup();
    try {
      const log = interventionLog(h.db);
      await log.closeDialogForRetry("unrelated-run", "failed");
      expect((await log.listForDecision(h.decisionId)).length).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
