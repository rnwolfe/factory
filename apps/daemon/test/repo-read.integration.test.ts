import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import {
  listBranches,
  listCommits,
  listTree,
  RepoReadError,
  readBlob,
} from "../src/projects/repo-read.ts";

async function git(args: string[], cwd: string): Promise<void> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const stderr = await new Response(p.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function makeRepo(): Promise<{ root: string; cleanup: () => void }> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-repo-test-"));
  await git(["init", "-q", "-b", "main"], root);
  await git(["config", "user.name", "Test"], root);
  await git(["config", "user.email", "test@example.com"], root);
  writeFileSync(path.join(root, "README.md"), "# hello\n", "utf8");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/index.ts"), "export const x = 1;\n", "utf8");
  await git(["add", "-A"], root);
  await git(["commit", "-q", "-m", "initial"], root);
  // Second commit so log has more than one row.
  writeFileSync(path.join(root, "README.md"), "# hello\nsecond line\n", "utf8");
  await git(["add", "-A"], root);
  await git(["commit", "-q", "-m", "update readme"], root);
  // Branch off and commit.
  await git(["checkout", "-q", "-b", "feature/x"], root);
  writeFileSync(path.join(root, "src/index.ts"), "export const x = 2;\n", "utf8");
  await git(["add", "-A"], root);
  await git(["commit", "-q", "-m", "feat: bump x"], root);
  await git(["checkout", "-q", "main"], root);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("repo-read", () => {
  test("listBranches returns main + feature branch with ahead/behind", async () => {
    const h = await makeRepo();
    try {
      const branches = await listBranches(h.root);
      const names = branches.map((b) => b.name).sort();
      expect(names).toEqual(["feature/x", "main"]);
      const main = branches.find((b) => b.name === "main");
      const feat = branches.find((b) => b.name === "feature/x");
      expect(main?.ahead).toBe(0);
      expect(main?.behind).toBe(0);
      // feature/x has one extra commit ahead of main.
      expect(feat?.ahead).toBe(1);
      expect(feat?.behind).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("listCommits returns ordered log with cursor pagination", async () => {
    const h = await makeRepo();
    try {
      const all = await listCommits(h.root, "main", { limit: 100 });
      expect(all.length).toBe(2);
      expect(all[0]?.subject).toBe("update readme");
      expect(all[1]?.subject).toBe("initial");
      const second = await listCommits(h.root, "main", { limit: 1, cursor: 1 });
      expect(second.length).toBe(1);
      expect(second[0]?.subject).toBe("initial");
    } finally {
      h.cleanup();
    }
  });

  test("listCommits rejects unknown ref with bad_ref", async () => {
    const h = await makeRepo();
    try {
      let thrown: unknown;
      try {
        await listCommits(h.root, "nope-ref-xyz", { limit: 5 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RepoReadError);
      if (thrown instanceof RepoReadError) expect(thrown.code).toBe("bad_ref");
    } finally {
      h.cleanup();
    }
  });

  test("listTree at HEAD root returns dirs first, then files", async () => {
    const h = await makeRepo();
    try {
      const root = await listTree(h.root, "HEAD", "");
      expect(root.length).toBe(2);
      expect(root[0]?.name).toBe("src");
      expect(root[0]?.type).toBe("tree");
      expect(root[1]?.name).toBe("README.md");
      expect(root[1]?.type).toBe("blob");
      expect(root[1]?.size).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  test("listTree drills into subdirectory", async () => {
    const h = await makeRepo();
    try {
      const sub = await listTree(h.root, "HEAD", "src");
      expect(sub.length).toBe(1);
      expect(sub[0]?.name).toBe("index.ts");
      expect(sub[0]?.path).toBe("src/index.ts");
    } finally {
      h.cleanup();
    }
  });

  test("readBlob returns text content for small text files", async () => {
    const h = await makeRepo();
    try {
      const r = await readBlob(h.root, "HEAD", "src/index.ts");
      expect(r.kind).toBe("text");
      if (r.kind === "text") {
        expect(r.content).toBe("export const x = 1;\n");
        expect(r.sizeBytes).toBeGreaterThan(0);
      }
    } finally {
      h.cleanup();
    }
  });

  test("readBlob returns binary marker for files with null bytes", async () => {
    const h = await makeRepo();
    try {
      // Create a binary file (4 bytes including a null) and commit it.
      writeFileSync(path.join(h.root, "blob.bin"), Buffer.from([0x01, 0x00, 0xff, 0x42]));
      await git(["add", "-A"], h.root);
      await git(["commit", "-q", "-m", "add binary"], h.root);
      const r = await readBlob(h.root, "HEAD", "blob.bin");
      expect(r.kind).toBe("binary");
      if (r.kind === "binary") expect(r.sizeBytes).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  test("readBlob rejects missing path with not_found", async () => {
    const h = await makeRepo();
    try {
      let thrown: unknown;
      try {
        await readBlob(h.root, "HEAD", "missing.txt");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RepoReadError);
      if (thrown instanceof RepoReadError) expect(thrown.code).toBe("not_found");
    } finally {
      h.cleanup();
    }
  });

  test("readBlob reads from non-default branch", async () => {
    const h = await makeRepo();
    try {
      const r = await readBlob(h.root, "feature/x", "src/index.ts");
      expect(r.kind).toBe("text");
      if (r.kind === "text") expect(r.content).toBe("export const x = 2;\n");
    } finally {
      h.cleanup();
    }
  });
});
