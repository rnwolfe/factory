import { describe, expect, test } from "bun:test";
import { agentForModel, clampModelToAgent } from "../src/agents/registry.ts";

// Backstop for the run-submit cross-agent model bug: a model id pinned for one
// agent (e.g. `claude-opus-4-8` in a task's frontmatter) resolving onto a run
// whose agent fell through to a different default (e.g. codex from the project)
// used to reach the provider verbatim — codex would get `--model
// claude-opus-4-8`, die within ~3s with no factory-status footer, and surface
// as a "blocked run" with no actionable reason. clampModelToAgent drops the
// model in exactly that case so the agent uses its own default instead.

describe("agentForModel", () => {
  test("claude model ids resolve to claude-code", () => {
    expect(agentForModel("claude-opus-4-8")).toBe("claude-code");
    expect(agentForModel("claude-sonnet-5")).toBe("claude-code");
  });

  test("gpt model ids resolve to codex", () => {
    expect(agentForModel("gpt-5.5")).toBe("codex");
    expect(agentForModel("gpt-5.4-mini")).toBe("codex");
  });

  test("unknown / gated ids belong to no registered agent", () => {
    expect(agentForModel("claude-fable-5")).toBeNull();
    expect(agentForModel("some-future-model")).toBeNull();
  });
});

describe("clampModelToAgent", () => {
  test("drops a claude model resolved onto codex (the incident)", () => {
    expect(clampModelToAgent("codex", "claude-opus-4-8")).toBeNull();
    expect(clampModelToAgent("codex", "claude-sonnet-5")).toBeNull();
  });

  test("drops a gpt model resolved onto claude-code", () => {
    expect(clampModelToAgent("claude-code", "gpt-5.5")).toBeNull();
  });

  test("keeps a model that matches its agent", () => {
    expect(clampModelToAgent("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(clampModelToAgent("claude-code", "claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  test("passes through null (CLI default) and opaque/gated ids untouched", () => {
    expect(clampModelToAgent("codex", null)).toBeNull();
    expect(clampModelToAgent("codex", "claude-fable-5")).toBe("claude-fable-5");
    expect(clampModelToAgent("claude-code", "claude-fable-5")).toBe("claude-fable-5");
  });
});
