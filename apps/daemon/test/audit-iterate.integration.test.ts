import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { parseAuditResponse } from "../src/audits/findings.ts";
import { runAuditIteration } from "../src/audits/iterate.ts";
import { listAuditSkills, readAuditSkill } from "../src/projects/audit-skills.ts";

function tempProject(): { dbPath: string; workdirPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-audit-test-"));
  const dbPath = path.join(root, "data.db");
  const workdirPath = path.join(root, "project");
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  mkdirSync(path.join(workdirPath, ".factory", "audits", "docs-audit"), { recursive: true });
  return {
    dbPath,
    workdirPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function writeSkill(workdirPath: string, name: string, kind: "read-only" | "exec", body: string) {
  const dir = path.join(workdirPath, ".factory", "audits", name);
  mkdirSync(dir, { recursive: true });
  const fm = `---\nname: ${name}\ndescription: test ${name}\nkind: ${kind}\nneeds_worktree: ${kind === "exec"}\ndefault_severity_grade: enabled\n---\n\n${body}`;
  writeFileSync(path.join(dir, "SKILL.md"), fm, "utf8");
}

describe("audit-skills loader", () => {
  test("listAuditSkills returns frontmatter for each skill dir", async () => {
    const { workdirPath, cleanup } = tempProject();
    try {
      writeSkill(workdirPath, "docs-audit", "read-only", "Audit the docs.");
      writeSkill(workdirPath, "code-review", "exec", "Review the code.");
      const skills = await listAuditSkills(workdirPath);
      expect(skills.map((s) => s.name).sort()).toEqual(["code-review", "docs-audit"]);
      const docs = skills.find((s) => s.name === "docs-audit");
      expect(docs?.kind).toBe("read-only");
      expect(docs?.needsWorktree).toBe(false);
      const cr = skills.find((s) => s.name === "code-review");
      expect(cr?.kind).toBe("exec");
      expect(cr?.needsWorktree).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("readAuditSkill returns full body and skips malformed dirs", async () => {
    const { workdirPath, cleanup } = tempProject();
    try {
      writeSkill(workdirPath, "drift-check", "read-only", "Compare touches against plan.");
      mkdirSync(path.join(workdirPath, ".factory", "audits", "broken"), { recursive: true });
      writeFileSync(
        path.join(workdirPath, ".factory", "audits", "broken", "SKILL.md"),
        "no frontmatter here",
        "utf8",
      );
      const found = await readAuditSkill(workdirPath, "drift-check");
      expect(found).not.toBeNull();
      expect(found?.body.includes("Compare touches")).toBe(true);
      // Listing should skip the broken dir without throwing.
      const skills = await listAuditSkills(workdirPath);
      expect(skills.map((s) => s.name)).toEqual(["drift-check"]);
    } finally {
      cleanup();
    }
  });
});

describe("parseAuditResponse", () => {
  test("parses a clean response", () => {
    const text = `\`\`\`json\n${JSON.stringify({
      reportMarkdown: "# Report\n\nClean.",
      findings: [
        {
          severity: "minor",
          title: "Stale link",
          body: "Link is broken.",
          filePath: "README.md",
          line: 10,
        },
      ],
    })}\n\`\`\``;
    const out = parseAuditResponse(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.reportMarkdown).toContain("Clean.");
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]?.severity).toBe("minor");
      expect(out.findings[0]?.id).toMatch(/^[a-z0-9]+$/i);
    }
  });

  test("malformed JSON returns ok:false", () => {
    const out = parseAuditResponse("not json");
    expect(out.ok).toBe(false);
  });

  test("missing reportMarkdown returns ok:false", () => {
    const out = parseAuditResponse(JSON.stringify({ findings: [] }));
    expect(out.ok).toBe(false);
  });

  test("invalid severity falls back to minor; out-of-spec fields ignored", () => {
    const out = parseAuditResponse(
      JSON.stringify({
        reportMarkdown: "ok",
        findings: [
          {
            severity: "WAT",
            title: "x",
            body: "y",
            filePath: null,
            line: null,
            extra: "ignore",
          },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.findings[0]?.severity).toBe("minor");
    }
  });
});

describe("runAuditIteration (mock agent)", () => {
  test("happy path: persists report + findings", async () => {
    const { dbPath, workdirPath, cleanup } = tempProject();
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      writeSkill(workdirPath, "docs-audit", "read-only", "Audit the docs.");

      const projectId = createId();
      const now = Date.now();
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "test-proj",
        name: "Test Project",
        role: "owner",
        ceremony: "personal",
        tag: "active",
        workdirPath,
        createdAt: now,
        lastActivityAt: now,
      });

      const auditId = createId();
      await db.insert(schema.audits).values({
        id: auditId,
        projectId,
        skillName: "docs-audit",
        skillVersion: "test-sha",
        status: "running",
        startedAt: now,
      });

      const result = await runAuditIteration(db, auditId, {
        agentInvoker: async () => ({
          text: `\`\`\`json\n${JSON.stringify({
            reportMarkdown: "# Docs audit\n\nFound 1 issue.",
            findings: [
              {
                severity: "major",
                title: "VISION.md missing",
                body: "Project should author one.",
                filePath: "docs/internal/VISION.md",
                line: null,
              },
            ],
          })}\n\`\`\``,
          sessionId: "audit-sess-001",
        }),
      });

      expect(result.reportPersisted).toBe(true);
      expect(result.audit.status).toBe("completed");
      expect(result.audit.reportMarkdown).toContain("Found 1 issue");
      const persisted = await db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, auditId))
        .get();
      expect(persisted?.findings).toContain("VISION.md missing");
      expect(persisted?.claudeSessionId).toBe("audit-sess-001");
    } finally {
      cleanup();
    }
  });

  test("malformed JSON marks audit failed without report", async () => {
    const { dbPath, workdirPath, cleanup } = tempProject();
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      writeSkill(workdirPath, "docs-audit", "read-only", "Audit the docs.");
      const projectId = createId();
      const now = Date.now();
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "test-proj",
        name: "Test Project",
        role: "owner",
        ceremony: "personal",
        tag: "active",
        workdirPath,
        createdAt: now,
        lastActivityAt: now,
      });
      const auditId = createId();
      await db.insert(schema.audits).values({
        id: auditId,
        projectId,
        skillName: "docs-audit",
        skillVersion: "test-sha",
        status: "running",
        startedAt: now,
      });
      const result = await runAuditIteration(db, auditId, {
        agentInvoker: async () => ({ text: "not json at all", sessionId: null }),
      });
      expect(result.reportPersisted).toBe(false);
      expect(result.audit.status).toBe("failed");
      expect(result.parseError).toContain("parse failed");
    } finally {
      cleanup();
    }
  });
});
