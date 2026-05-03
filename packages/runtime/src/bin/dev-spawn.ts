#!/usr/bin/env bun
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { claudeCodeAgent } from "../agents/claude-code.ts";
import { runtime } from "../runtime.ts";
import { hostSandbox } from "../sandboxes/host.ts";

function usage(): never {
  console.error("usage: bun packages/runtime/src/bin/dev-spawn.ts <projectPath> <prompt>");
  process.exit(2);
}

const [projectArg, promptArg] = process.argv.slice(2);
if (!projectArg || !promptArg) usage();

const projectPath = path.resolve(projectArg);
const ac = new AbortController();
process.on("SIGINT", () => {
  console.error("\n[dev-spawn] SIGINT — aborting…");
  ac.abort();
});
process.on("SIGTERM", () => ac.abort());

const runId = createId();

const result = await runtime.spawn({
  runId,
  projectPath,
  task: { id: "dev-spawn", prompt: promptArg },
  agent: claudeCodeAgent,
  sandbox: hostSandbox,
  strategy: { type: "head" },
  budgetSeconds: 600,
  maxIterations: 1,
  abort: ac.signal,
  onEvent: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

console.error("\n[dev-spawn] result:");
console.error(JSON.stringify(result, null, 2));
