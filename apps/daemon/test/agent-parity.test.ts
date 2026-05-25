import { describe, expect, test } from "bun:test";
import { normalizeAgent } from "../src/agents/resolve.ts";
import {
  type AgentName,
  agentByName,
  agentSupportsResume,
  ResumeUnsupportedError,
  SUPPORTED_AGENT_NAMES,
} from "../src/plans/invoke-claude.ts";

/**
 * Wire-level parity contracts that don't require spawning a real CLI.
 * Asserts the dispatch surface in `invokeClaudeJson` + `resolveAgent`
 * behaves identically across agents, and pins the resume-gap behavior
 * documented in docs/internal/codex-parity.md.
 */
describe("agent dispatch parity", () => {
  test("SUPPORTED_AGENT_NAMES enumerates exactly claude-code and codex", () => {
    expect(Array.from(SUPPORTED_AGENT_NAMES).sort()).toEqual(["claude-code", "codex"]);
  });

  test("agentByName returns a usable AgentSpec for every supported name", () => {
    for (const name of SUPPORTED_AGENT_NAMES) {
      const spec = agentByName(name);
      expect(spec.name).toBe(name);
      expect(typeof spec.buildArgv).toBe("function");
      expect(typeof spec.parseLine).toBe("function");
    }
  });

  test("agentSupportsResume: claude-code yes, codex no", () => {
    expect(agentSupportsResume("claude-code")).toBe(true);
    expect(agentSupportsResume("codex")).toBe(false);
  });

  test("normalizeAgent normalizes whitespace and rejects unknown agents", () => {
    expect(normalizeAgent("claude-code")).toBe("claude-code");
    expect(normalizeAgent("  codex  ")).toBe("codex");
    expect(normalizeAgent("")).toBeNull();
    expect(normalizeAgent(null)).toBeNull();
    expect(normalizeAgent(undefined)).toBeNull();
    expect(normalizeAgent("gpt-5")).toBeNull();
    expect(normalizeAgent("Claude-Code")).toBeNull(); // case-sensitive on purpose
  });

  test("buildArgv on both agents produces an argv whose first element is the CLI", () => {
    const claudeArgv = agentByName("claude-code").buildArgv("hello", {});
    expect(claudeArgv.argv[0]).toBe("claude");
    expect(claudeArgv.stdin).toBe("hello");

    const codexArgv = agentByName("codex").buildArgv("hello", {});
    expect(codexArgv.argv[0]).toBe("codex");
    expect(codexArgv.stdin).toBe("hello");
  });

  test("claude-code buildArgv honors resumeSessionId; codex ignores it (resume unsupported)", () => {
    const claudeArgv = agentByName("claude-code").buildArgv("hi", { resumeSessionId: "sess-1" });
    expect(claudeArgv.argv).toContain("--resume");
    expect(claudeArgv.argv).toContain("sess-1");

    // codex does not have a --resume flag and intentionally drops the option.
    const codexArgv = agentByName("codex").buildArgv("hi", { resumeSessionId: "sess-1" });
    expect(codexArgv.argv.includes("--resume")).toBe(false);
    expect(codexArgv.argv.includes("sess-1")).toBe(false);
  });

  test("ResumeUnsupportedError carries the agentName for caller dispatch", () => {
    const err = new ResumeUnsupportedError("codex");
    expect(err.name).toBe("ResumeUnsupportedError");
    expect(err.agentName).toBe("codex");
    expect(err.message).toContain("codex");
    expect(err.message).toContain("codex-parity.md");
  });

  test("AgentName type covers all SUPPORTED_AGENT_NAMES entries", () => {
    // Compile-time check: this assignment fails if AgentName diverges from
    // SUPPORTED_AGENT_NAMES. The runtime assertion is a no-op formality.
    const _names: AgentName[] = [...SUPPORTED_AGENT_NAMES];
    expect(_names.length).toBeGreaterThan(0);
  });
});
