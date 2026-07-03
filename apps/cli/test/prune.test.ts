import { describe, expect, test } from "bun:test";
import { parsePruneArgs } from "../src/commands/prune.ts";

describe("parsePruneArgs", () => {
  test("defaults are safe: dry-run, completed-only, no project, no age cap, 30d logs", () => {
    const a = parsePruneArgs([]);
    expect(a.apply).toBe(false);
    expect(a.includeFailed).toBe(false);
    expect(a.project).toBeNull();
    expect(a.ageDays).toBe(0);
    expect(a.logsOlderThan).toBe(30);
    expect(a.help).toBe(false);
  });

  test("--apply flips dry-run off", () => {
    expect(parsePruneArgs(["--apply"]).apply).toBe(true);
  });

  test("--include-failed broadens the status filter", () => {
    expect(parsePruneArgs(["--include-failed"]).includeFailed).toBe(true);
  });

  test("--project supports both --project=slug and --project slug forms", () => {
    expect(parsePruneArgs(["--project=factory"]).project).toBe("factory");
    expect(parsePruneArgs(["--project", "factory"]).project).toBe("factory");
  });

  test("--age supports both --age=N and --age N forms", () => {
    expect(parsePruneArgs(["--age=14"]).ageDays).toBe(14);
    expect(parsePruneArgs(["--age", "7"]).ageDays).toBe(7);
  });

  test("--logs-older-than supports both = and space forms", () => {
    expect(parsePruneArgs(["--logs-older-than=7"]).logsOlderThan).toBe(7);
    expect(parsePruneArgs(["--logs-older-than", "14"]).logsOlderThan).toBe(14);
  });

  test("flags combine without interfering", () => {
    const a = parsePruneArgs([
      "--apply",
      "--include-failed",
      "--project=factory",
      "--age=30",
      "--logs-older-than=7",
    ]);
    expect(a).toEqual({
      apply: true,
      includeFailed: true,
      project: "factory",
      ageDays: 30,
      logsOlderThan: 7,
      help: false,
    });
  });

  test("--help / -h surfaces", () => {
    expect(parsePruneArgs(["--help"]).help).toBe(true);
    expect(parsePruneArgs(["-h"]).help).toBe(true);
  });
});
