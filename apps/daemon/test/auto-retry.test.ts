import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { maybeAutoRetryGatedRun } from "../src/workers/auto-retry.ts";
import type { SubmitRunDeps } from "../src/workers/submit.ts";
import {
  hasActionableDefect,
  renderVerifierFindings,
  type VerifierReport,
} from "../src/workers/verifier.ts";

const failReport: VerifierReport = {
  score: 0.3,
  level: "low",
  signals: [
    { key: "cross-model", label: "Cross-model review", state: "fail", detail: "drops legacy rows" },
    { key: "acceptance", label: "Acceptance criteria", state: "absent", detail: "none" },
  ],
};

const absentOnly: VerifierReport = {
  score: 0,
  level: "none",
  signals: [{ key: "acceptance", label: "Acceptance criteria", state: "absent", detail: "none" }],
};

describe("verifier retry helpers", () => {
  test("hasActionableDefect: true with a fail, false when only absent/pass", () => {
    expect(hasActionableDefect(failReport)).toBe(true);
    expect(hasActionableDefect(absentOnly)).toBe(false);
  });

  test("renderVerifierFindings lists fails as FAILED and absent as MISSING", () => {
    const out = renderVerifierFindings(failReport);
    expect(out).toContain("Cross-model review — FAILED");
    expect(out).toContain("drops legacy rows");
    expect(out).toContain("Acceptance criteria — MISSING");
    expect(renderVerifierFindings(null)).toBe("");
  });
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "auto-retry-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  return { db: createDb(dbPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(db: ReturnType<typeof createDb>, autonomyConfig?: object): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: `s-${id.slice(0, 6)}`,
      name: "Demo",
      ceremony: "personal",
      workdirPath: `/tmp/${id}`,
      createdAt: now,
      lastActivityAt: now,
      autonomyMode: "autonomous",
      autonomyConfig: autonomyConfig ? JSON.stringify(autonomyConfig) : null,
    })
    .run();
  return id;
}

function addRun(
  db: ReturnType<typeof createDb>,
  projectId: string,
  retryOf: string | null,
): string {
  const id = createId();
  db.insert(schema.runs)
    .values({
      id,
      projectId,
      status: "needs_review",
      branch: `factory/run-${id.slice(0, 6)}`,
      worktreePath: `/tmp/wt-${id.slice(0, 6)}`,
      startedAt: Date.now(),
      budgetSeconds: 60,
      retryOfRunId: retryOf,
    })
    .run();
  return id;
}

// These cases all return BEFORE submitRun, so only `db` is touched on deps.
function depsFor(db: ReturnType<typeof createDb>): SubmitRunDeps {
  return { db } as unknown as SubmitRunDeps;
}

describe("maybeAutoRetryGatedRun — surface (null) branches", () => {
  test("budget 0 → surfaces (null), even with an actionable defect", async () => {
    const h = setup();
    try {
      const p = addProject(h.db, { retry: { verifierBudget: 0 } });
      const r = addRun(h.db, p, null);
      const out = await maybeAutoRetryGatedRun(depsFor(h.db), {
        runId: r,
        projectId: p,
        projectName: "Demo",
        taskId: null,
        sourceWorktreePath: "/tmp/does-not-exist",
        sourceBranch: "factory/run-test",
        agentName: "claude-code",
        report: failReport,
      });
      expect(out.retriedRunId).toBeNull();
      expect(out.exhausted).toBe(false); // opted out, not exhausted
    } finally {
      h.cleanup();
    }
  });

  test("absent-only (no actionable defect) → surfaces (null) even with budget", async () => {
    const h = setup();
    try {
      const p = addProject(h.db); // default budget 2
      const r = addRun(h.db, p, null);
      const out = await maybeAutoRetryGatedRun(depsFor(h.db), {
        runId: r,
        projectId: p,
        projectName: "Demo",
        taskId: null,
        sourceWorktreePath: "/tmp/does-not-exist",
        sourceBranch: "factory/run-test",
        agentName: "claude-code",
        report: absentOnly,
      });
      expect(out.retriedRunId).toBeNull();
      expect(out.exhausted).toBe(false); // absent-only is not "exhausted"
    } finally {
      h.cleanup();
    }
  });

  test("exhausted retry chain → surfaces (null) and flags exhausted", async () => {
    const h = setup();
    try {
      const p = addProject(h.db, { retry: { verifierBudget: 1 } });
      const r0 = addRun(h.db, p, null);
      const r1 = addRun(h.db, p, r0); // chain depth of r1 = 1 == budget
      const out = await maybeAutoRetryGatedRun(depsFor(h.db), {
        runId: r1,
        projectId: p,
        projectName: "Demo",
        taskId: null,
        sourceWorktreePath: "/tmp/does-not-exist",
        sourceBranch: "factory/run-test",
        agentName: "claude-code",
        report: failReport,
      });
      expect(out.retriedRunId).toBeNull();
      expect(out.exhausted).toBe(true); // the "loop gave up" signal
    } finally {
      h.cleanup();
    }
  });
});
