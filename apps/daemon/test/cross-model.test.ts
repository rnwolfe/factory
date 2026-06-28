import { describe, expect, test } from "bun:test";
import { buildCrossModelPrompt, crossModelValidate } from "../src/workers/cross-model.ts";

const base = {
  diff: "diff-body-here",
  acceptance: [],
  taskTitle: "Do the thing",
  summary: "did it",
};

describe("crossModelValidate", () => {
  test("routes to the OTHER family and parses a verdict", async () => {
    let calledAgent = "";
    const v = await crossModelValidate(
      { ...base, builderAgent: "claude-code" },
      {
        invoke: async (prompt, agent) => {
          calledAgent = agent;
          expect(prompt).toContain("diff-body-here");
          return '```json\n{"state":"pass","confidence":0.9,"reasoning":"clean"}\n```';
        },
      },
    );
    expect(calledAgent).toBe("codex"); // opposite of the builder
    expect(v).toEqual({ validator: "codex", state: "pass", confidence: 0.9, reasoning: "clean" });
  });

  test("codex builder → claude-code validates", async () => {
    let calledAgent = "";
    await crossModelValidate(
      { ...base, builderAgent: "codex" },
      {
        invoke: async (_p, agent) => {
          calledAgent = agent;
          return '```json\n{"state":"concerns","confidence":0.5,"reasoning":"unsure"}\n```';
        },
      },
    );
    expect(calledAgent).toBe("claude-code");
  });

  test("clamps confidence and accepts concerns/fail", async () => {
    const v = await crossModelValidate(
      { ...base, builderAgent: "codex" },
      { invoke: async () => '```json\n{"state":"fail","confidence":5,"reasoning":"bug"}\n```' },
    );
    expect(v?.state).toBe("fail");
    expect(v?.confidence).toBe(1); // clamped
  });

  test("invoke failure → null (absent coverage, never a false pass)", async () => {
    const v = await crossModelValidate(
      { ...base, builderAgent: "claude-code" },
      {
        invoke: async () => {
          throw new Error("codex auth missing");
        },
      },
    );
    expect(v).toBeNull();
  });

  test("unparseable / invalid state → null", async () => {
    expect(
      await crossModelValidate(
        { ...base, builderAgent: "claude-code" },
        { invoke: async () => "no json here" },
      ),
    ).toBeNull();
    expect(
      await crossModelValidate(
        { ...base, builderAgent: "claude-code" },
        { invoke: async () => '```json\n{"state":"maybe"}\n```' },
      ),
    ).toBeNull();
  });
});

describe("buildCrossModelPrompt", () => {
  test("frames adversarial cross-family review with the diff + acceptance", () => {
    const p = buildCrossModelPrompt(
      { ...base, builderAgent: "claude-code", acceptance: [{ criterion: "compiles", met: true }] },
      "codex",
    );
    expect(p).toContain("adversarial");
    expect(p).toContain("DIFFERENT model family");
    expect(p).toContain("compiles");
    expect(p).toContain("diff-body-here");
    expect(p).toContain('"state"');
  });
});
