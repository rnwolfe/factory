import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import {
  extractAgentDecisions,
  newAgentDecisionState,
  persistAgentDecisions,
} from "../src/workers/agent-decisions.ts";

function tempDb(): { dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-agent-dec-test-"));
  return {
    dbPath: path.join(root, "data.db"),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function makeRecordingBus(): { events: EventBus; published: DaemonEvent[] } {
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  return { events, published };
}

const SINGLE_DECISION_BLOCK = `
some agent prose…

\`\`\`factory-decision
{
  "id": "dec-001",
  "kind": "library",
  "summary": "use bun:sqlite over better-sqlite3",
  "context": "Both fit; bun:sqlite is built-in and the project is bun-only.",
  "options": [
    { "title": "bun:sqlite", "tradeoff": "no extra dep, runtime-tied", "chosen": true },
    { "title": "better-sqlite3", "tradeoff": "portable, but extra C dep" }
  ],
  "decided": "bun:sqlite",
  "reasoning": "the project is already 100% bun, and we don't need portability."
}
\`\`\`

agent continues working…
`;

const TWO_DECISIONS = `
\`\`\`factory-decision
{
  "id": "dec-001",
  "kind": "library",
  "summary": "use bun:sqlite",
  "context": "ctx",
  "options": [
    { "title": "bun:sqlite", "tradeoff": "no dep", "chosen": true }
  ],
  "decided": "bun:sqlite",
  "reasoning": "..."
}
\`\`\`

\`\`\`factory-decision
{
  "id": "dec-002",
  "kind": "naming",
  "summary": "name the field \\"startedAt\\" not \\"start_time\\"",
  "context": "Match existing conventions in the codebase.",
  "options": [
    { "title": "startedAt (camelCase)", "tradeoff": "matches drizzle pattern", "chosen": true },
    { "title": "start_time (snake_case)", "tradeoff": "matches sql column" }
  ],
  "decided": "startedAt (camelCase)",
  "reasoning": "drizzle generates the column name from the JS field; camel is the JS norm."
}
\`\`\`
`;

describe("extractAgentDecisions", () => {
  test("parses a single fenced block", () => {
    const decisions = extractAgentDecisions(SINGLE_DECISION_BLOCK);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.id).toBe("dec-001");
    expect(decisions[0]?.kind).toBe("library");
    expect(decisions[0]?.decided).toBe("bun:sqlite");
    expect(decisions[0]?.options).toHaveLength(2);
    expect(decisions[0]?.options[0]?.chosen).toBe(true);
  });

  test("parses multiple blocks in order", () => {
    const decisions = extractAgentDecisions(TWO_DECISIONS);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.id).toBe("dec-001");
    expect(decisions[1]?.id).toBe("dec-002");
    expect(decisions[1]?.kind).toBe("naming");
  });

  test("ignores blocks missing id", () => {
    const text = `\`\`\`factory-decision
{ "summary": "no id here", "options": [] }
\`\`\``;
    expect(extractAgentDecisions(text)).toHaveLength(0);
  });

  test("ignores blocks with malformed JSON", () => {
    const text = `\`\`\`factory-decision
{ this is not json
\`\`\``;
    expect(extractAgentDecisions(text)).toHaveLength(0);
  });

  test("falls back to first chosen option when decided is missing", () => {
    const text = `\`\`\`factory-decision
{
  "id": "dec-x",
  "summary": "x",
  "options": [
    { "title": "A", "tradeoff": "a" },
    { "title": "B", "tradeoff": "b", "chosen": true }
  ]
}
\`\`\``;
    const decisions = extractAgentDecisions(text);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decided).toBe("B");
  });

  test("coerces unknown kind to tradeoff", () => {
    const text = `\`\`\`factory-decision
{ "id": "dec-z", "kind": "made-up-kind", "summary": "x", "options": [], "decided": "x" }
\`\`\``;
    expect(extractAgentDecisions(text)[0]?.kind).toBe("tradeoff");
  });

  test("explicit responseType=multi is honored", () => {
    const text = `\`\`\`factory-decision
{
  "id": "dec-multi",
  "responseType": "multi",
  "summary": "v1 surface",
  "options": [
    { "title": "A", "chosen": true },
    { "title": "B", "chosen": true },
    { "title": "C" }
  ],
  "decided": "A, B"
}
\`\`\``;
    const decisions = extractAgentDecisions(text);
    expect(decisions[0]?.responseType).toBe("multi");
    expect(decisions[0]?.decided).toBe("A, B");
  });

  test("explicit responseType=free with no options", () => {
    const text = `\`\`\`factory-decision
{
  "id": "dec-free",
  "responseType": "free",
  "summary": "name the new field",
  "decided": "startedAt"
}
\`\`\``;
    const decisions = extractAgentDecisions(text);
    expect(decisions[0]?.responseType).toBe("free");
    expect(decisions[0]?.options).toHaveLength(0);
    expect(decisions[0]?.decided).toBe("startedAt");
  });

  test("inferred responseType: no options → free; multiple chosen → multi", () => {
    const freeText = `\`\`\`factory-decision
{ "id": "dec-1", "summary": "x", "decided": "y" }
\`\`\``;
    expect(extractAgentDecisions(freeText)[0]?.responseType).toBe("free");

    const multiText = `\`\`\`factory-decision
{
  "id": "dec-2",
  "summary": "y",
  "options": [
    { "title": "A", "chosen": true },
    { "title": "B", "chosen": true }
  ]
}
\`\`\``;
    expect(extractAgentDecisions(multiText)[0]?.responseType).toBe("multi");
  });

  test("multi: decided falls back to comma-joined chosen titles when missing", () => {
    const text = `\`\`\`factory-decision
{
  "id": "dec-m",
  "responseType": "multi",
  "summary": "x",
  "options": [
    { "title": "A", "chosen": true },
    { "title": "B" },
    { "title": "C", "chosen": true }
  ]
}
\`\`\``;
    expect(extractAgentDecisions(text)[0]?.decided).toBe("A, C");
  });
});

describe("persistAgentDecisions", () => {
  test("inserts a new row + publishes inbox event for each new decision id", async () => {
    const { dbPath, cleanup } = tempDb();
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      const projectId = createId();
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "p1",
        name: "P1",
        ceremony: "personal",
        role: "owner",
        tag: "active",
        workdirPath: "/tmp/p1",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      const { events, published } = makeRecordingBus();
      const state = newAgentDecisionState();

      const result = await persistAgentDecisions({
        db,
        events,
        runId: "run-1",
        taskId: "task-001",
        projectId,
        agentText: SINGLE_DECISION_BLOCK,
        state,
      });

      expect(result.inserted).toHaveLength(1);
      const inboxEvents = published.filter((e) => e.channel === "inbox");
      expect(inboxEvents).toHaveLength(1);
      expect(inboxEvents[0]?.kind).toBe("decision_created");

      const rows = await db.select().from(schema.decisions).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("agent_decision");
      expect(rows[0]?.outcome).toContain("bun:sqlite");
      expect(rows[0]?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("autoRatify records the fork as auto_ratified, not pending (Trust Ladder L2)", async () => {
    const { dbPath, cleanup } = tempDb();
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      const projectId = createId();
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "p2",
        name: "P2",
        ceremony: "personal",
        role: "owner",
        tag: "active",
        workdirPath: "/tmp/p2",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      const { events } = makeRecordingBus();
      await persistAgentDecisions({
        db,
        events,
        runId: "run-2",
        taskId: "task-002",
        projectId,
        agentText: SINGLE_DECISION_BLOCK,
        state: newAgentDecisionState(),
        autoRatify: true,
      });
      const rows = await db.select().from(schema.decisions).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("auto_ratified"); // out of the pending inbox, kept in history
    } finally {
      cleanup();
    }
  });

  test("dedupes by agent-supplied id across calls", async () => {
    const { dbPath, cleanup } = tempDb();
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      const projectId = createId();
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "p2",
        name: "P2",
        ceremony: "tinker",
        role: "owner",
        tag: "active",
        workdirPath: "/tmp/p2",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      const { events } = makeRecordingBus();
      const state = newAgentDecisionState();

      // First call: emits dec-001.
      const r1 = await persistAgentDecisions({
        db,
        events,
        runId: "run-1",
        taskId: null,
        projectId,
        agentText: SINGLE_DECISION_BLOCK,
        state,
      });
      expect(r1.inserted).toHaveLength(1);

      // Second call with the same text + state: no new inserts.
      const r2 = await persistAgentDecisions({
        db,
        events,
        runId: "run-1",
        taskId: null,
        projectId,
        agentText: SINGLE_DECISION_BLOCK,
        state,
      });
      expect(r2.inserted).toHaveLength(0);

      // Third call with text containing a NEW second decision: only the new
      // one is inserted.
      const r3 = await persistAgentDecisions({
        db,
        events,
        runId: "run-1",
        taskId: null,
        projectId,
        agentText: TWO_DECISIONS,
        state,
      });
      expect(r3.inserted).toHaveLength(1);
      expect(r3.inserted[0]?.payload.id).toBe("dec-002");

      const rows = await db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.kind, "agent_decision"))
        .all();
      expect(rows).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});
