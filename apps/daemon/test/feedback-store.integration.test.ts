import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations } from "@factory/db";
import {
  appendFeedback,
  getFeedback,
  listOpenFeedback,
  setFeedbackStatus,
} from "../src/feedback/store.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-feedback-test-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("feedback store", () => {
  test("appendFeedback persists vote + body + context", () => {
    const h = setup();
    try {
      const row = appendFeedback(h.db, {
        vote: "up",
        body: "love it",
        contextRoute: "/audits/123",
        contextHint: "audit-pane",
      });
      expect(row?.vote).toBe("up");
      expect(row?.body).toBe("love it");
      expect(row?.contextRoute).toBe("/audits/123");
      expect(row?.status).toBe("open");
    } finally {
      h.cleanup();
    }
  });

  test("listOpenFeedback returns open + in_progress only, newest first", () => {
    const h = setup();
    try {
      const a = appendFeedback(h.db, { vote: "up", body: "a" });
      const b = appendFeedback(h.db, { vote: "down", body: "b" });
      const c = appendFeedback(h.db, { vote: "up", body: "c" });
      if (!a || !b || !c) throw new Error("seed failed");
      // Move a to dismissed; should disappear from inbox.
      setFeedbackStatus(h.db, a.id, "dismissed");
      // Move b to in_progress; should still appear.
      setFeedbackStatus(h.db, b.id, "in_progress");

      const open = listOpenFeedback(h.db);
      expect(open.length).toBe(2);
      expect(open.map((r) => r.id)).toContain(b.id);
      expect(open.map((r) => r.id)).toContain(c.id);
      expect(open.map((r) => r.id)).not.toContain(a.id);
    } finally {
      h.cleanup();
    }
  });

  test("setFeedbackStatus to resolved sets resolvedAt + resolvedTarget", () => {
    const h = setup();
    try {
      const a = appendFeedback(h.db, { vote: "up", body: "x" });
      if (!a) throw new Error("seed failed");
      setFeedbackStatus(h.db, a.id, "resolved", { resolvedTarget: "plan:abc" });
      const row = getFeedback(h.db, a.id);
      expect(row?.status).toBe("resolved");
      expect(row?.resolvedTarget).toBe("plan:abc");
      expect(row?.resolvedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("setFeedbackStatus back from resolved clears resolvedAt", () => {
    const h = setup();
    try {
      const a = appendFeedback(h.db, { vote: "up", body: "x" });
      if (!a) throw new Error("seed failed");
      setFeedbackStatus(h.db, a.id, "resolved");
      setFeedbackStatus(h.db, a.id, "open");
      const row = getFeedback(h.db, a.id);
      expect(row?.status).toBe("open");
      expect(row?.resolvedAt).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
