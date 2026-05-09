import { type AuditFinding, auditFindingSeverityEnum } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { extractJsonObject } from "../plans/json-extract.ts";

export interface AuditAgentResponse {
  reportMarkdown: string;
  findings: AuditFinding[];
}

interface ParseResult {
  ok: true;
  reportMarkdown: string;
  findings: AuditFinding[];
}
interface ParseError {
  ok: false;
  error: string;
}
export type ParseAuditResult = ParseResult | ParseError;

const REPORT_FENCE_RE = /```\s*factory-audit-report\s*\n([\s\S]*?)\n```/i;

/**
 * Parse an audit agent response. Two-block envelope is preferred:
 *
 *     ```factory-audit-report
 *     <markdown report>
 *     ```
 *
 *     ```json
 *     { "findings": [...] }
 *     ```
 *
 * Falls back to the legacy single-JSON envelope (`{reportMarkdown, findings}`)
 * for backward compat with prompts/sessions still on the old contract.
 *
 * Mirrors the v0.2 plan iteration "null parse → fail" honesty contract.
 */
export function parseAuditResponse(text: string): ParseAuditResult {
  const fence = REPORT_FENCE_RE.exec(text);
  if (fence?.[1]) {
    return parseTwoBlock(text, fence[1]);
  }
  return parseLegacySingleBlock(text);
}

function parseTwoBlock(fullText: string, reportContent: string): ParseAuditResult {
  // Strip the report fence from the searchable text so the JSON extractor
  // doesn't trip over braces inside the markdown report.
  const withoutReport = fullText.replace(REPORT_FENCE_RE, "");
  let raw: unknown;
  try {
    raw = extractJsonObject<unknown>(withoutReport);
  } catch (err) {
    return {
      ok: false,
      error: `report fence parsed but findings JSON missing: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "findings block is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : null;
  if (rawFindings === null) {
    return { ok: false, error: "findings block missing findings array" };
  }
  const findings = rawFindings
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => coerceFinding(f));
  return { ok: true, reportMarkdown: reportContent.trim(), findings };
}

function parseLegacySingleBlock(text: string): ParseAuditResult {
  let raw: unknown;
  try {
    raw = extractJsonObject<unknown>(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "audit response is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const reportMarkdown = typeof obj.reportMarkdown === "string" ? obj.reportMarkdown : null;
  if (reportMarkdown === null) {
    return {
      ok: false,
      error:
        "audit response missing both `factory-audit-report` fence and legacy reportMarkdown string",
    };
  }
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : null;
  if (rawFindings === null) {
    return { ok: false, error: "audit response missing findings array" };
  }
  const findings = rawFindings
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => coerceFinding(f));
  return { ok: true, reportMarkdown, findings };
}

function coerceFinding(obj: Record<string, unknown>): AuditFinding {
  const severity =
    typeof obj.severity === "string" &&
    (auditFindingSeverityEnum as readonly string[]).includes(obj.severity)
      ? (obj.severity as AuditFinding["severity"])
      : "minor";
  const title = typeof obj.title === "string" ? obj.title.slice(0, 240) : "(untitled finding)";
  const body = typeof obj.body === "string" ? obj.body : "";
  const filePath = typeof obj.filePath === "string" ? obj.filePath : null;
  const line =
    typeof obj.line === "number" && Number.isFinite(obj.line) ? Math.trunc(obj.line) : null;
  const id = typeof obj.id === "string" && /^[a-z0-9]{8,}$/i.test(obj.id) ? obj.id : createId();
  return {
    id,
    severity,
    title,
    body,
    filePath,
    line,
    promotedTo: null,
  };
}

/**
 * Read findings JSON from an audit row. Returns [] for null/empty/malformed.
 * Defensive: callers may write back the parsed array on save, so a malformed
 * column shouldn't crash the read path.
 */
export function readFindings(rawJson: string | null): AuditFinding[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
      .map((f) => coerceFinding(f));
  } catch {
    return [];
  }
}

export function writeFindings(findings: AuditFinding[]): string {
  return JSON.stringify(findings);
}
