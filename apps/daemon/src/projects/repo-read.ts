import { spawn as bunSpawn } from "bun";

/**
 * Read-only git access for the repo browser. All paths run `git` in the
 * project workdir as the only filesystem entry point — we never read files
 * directly off disk, so the working tree's mode bits and permissions are
 * never relied on.
 *
 * Inputs are validated at the router boundary; this module assumes its
 * callers have already enforced ref/path shape (see `validate.ts`). It
 * still passes args via `git`'s argv form (no shell), so even with a
 * malicious caller the worst case is a `git`-internal error, not RCE.
 */

const MAX_BLOB_BYTES = 5 * 1024 * 1024;

export interface BranchInfo {
  name: string;
  sha: string;
  subject: string;
  ts: number;
  ahead: number | null;
  behind: number | null;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  ts: number;
}

export type TreeEntryType = "blob" | "tree" | "symlink";

export interface TreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  mode: string;
  size: number | null;
}

export type BlobResult =
  | { kind: "text"; content: string; sizeBytes: number }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "too_large"; sizeBytes: number };

export class RepoReadError extends Error {
  constructor(
    public readonly code: "bad_ref" | "bad_path" | "not_found" | "git_failed" | "no_main",
    message: string,
  ) {
    super(message);
    this.name = "RepoReadError";
  }
}

/** Approximate ahead/behind via `git rev-list --left-right --count main...<branch>`. */
async function aheadBehindFromMain(
  workdirPath: string,
  branch: string,
  mainName: string,
): Promise<{ ahead: number; behind: number } | null> {
  const res = await git(
    ["rev-list", "--left-right", "--count", `${mainName}...${branch}`],
    workdirPath,
  );
  if (res.exitCode !== 0) return null;
  const m = res.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

export async function listBranches(workdirPath: string): Promise<BranchInfo[]> {
  const res = await git(
    [
      "for-each-ref",
      "refs/heads/",
      "--format=%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(subject)",
    ],
    workdirPath,
  );
  if (res.exitCode !== 0) {
    throw new RepoReadError("git_failed", res.stderr || "git for-each-ref failed");
  }
  const lines = res.stdout.split("\n").filter((l) => l.length > 0);
  const branches: BranchInfo[] = [];
  // Determine the "main" branch — prefer `main`, then `master`. If neither
  // exists, ahead/behind is null for every branch.
  const names = lines.map((l) => l.split("\t", 1)[0]);
  let mainName: string | null = null;
  if (names.includes("main")) mainName = "main";
  else if (names.includes("master")) mainName = "master";

  for (const line of lines) {
    const parts = line.split("\t");
    const name = parts[0] ?? "";
    const sha = parts[1] ?? "";
    const tsRaw = parts[2] ?? "0";
    const subject = parts.slice(3).join("\t");
    let ahead: number | null = null;
    let behind: number | null = null;
    if (mainName && name !== mainName) {
      const ab = await aheadBehindFromMain(workdirPath, name, mainName);
      if (ab) {
        ahead = ab.ahead;
        behind = ab.behind;
      }
    } else if (name === mainName) {
      ahead = 0;
      behind = 0;
    }
    branches.push({
      name,
      sha,
      subject,
      ts: Number(tsRaw) * 1000,
      ahead,
      behind,
    });
  }
  branches.sort((a, b) => b.ts - a.ts);
  return branches;
}

export async function listCommits(
  workdirPath: string,
  ref: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<CommitInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const skip = Math.max(opts.cursor ?? 0, 0);
  const res = await git(
    ["log", `--max-count=${limit}`, `--skip=${skip}`, "--format=%H%x09%an%x09%ct%x09%s", ref],
    workdirPath,
  );
  if (res.exitCode !== 0) {
    if (/unknown revision|ambiguous argument/i.test(res.stderr)) {
      throw new RepoReadError("bad_ref", `unknown ref: ${ref}`);
    }
    throw new RepoReadError("git_failed", res.stderr || "git log failed");
  }
  const out: CommitInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const sha = parts[0] ?? "";
    const author = parts[1] ?? "";
    const tsRaw = parts[2] ?? "0";
    const subject = parts.slice(3).join("\t");
    out.push({ sha, author, ts: Number(tsRaw) * 1000, subject });
  }
  return out;
}

export async function listTree(
  workdirPath: string,
  ref: string,
  treePath: string,
): Promise<TreeEntry[]> {
  // git ls-tree <ref>:<path> emits "<mode> <type> <sha>\t<name>".
  const target = treePath ? `${ref}:${treePath}` : `${ref}:`;
  const res = await git(["ls-tree", "--long", target], workdirPath);
  if (res.exitCode !== 0) {
    if (/Not a valid object name|exists on disk, but not in/i.test(res.stderr)) {
      throw new RepoReadError("not_found", `path not found at ref: ${treePath || "/"}`);
    }
    if (/unknown revision|ambiguous argument/i.test(res.stderr)) {
      throw new RepoReadError("bad_ref", `unknown ref: ${ref}`);
    }
    throw new RepoReadError("git_failed", res.stderr || "git ls-tree failed");
  }
  const out: TreeEntry[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    // ls-tree --long: "<mode> <type> <sha> <size>\t<name>" — size is "-" for trees.
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const left = line.slice(0, tabIdx);
    const name = line.slice(tabIdx + 1);
    const fields = left.split(/\s+/);
    if (fields.length < 4) continue;
    const mode = fields[0] ?? "";
    const type = (fields[1] ?? "") as "blob" | "tree" | "commit";
    const sizeRaw = fields[3] ?? "-";
    const size = sizeRaw === "-" ? null : Number(sizeRaw);
    let entryType: TreeEntryType;
    if (mode === "120000") entryType = "symlink";
    else if (type === "tree") entryType = "tree";
    else entryType = "blob";
    const childPath = treePath ? `${treePath}/${name}` : name;
    out.push({ name, path: childPath, type: entryType, mode, size });
  }
  // Sort: dirs first, then files, alphabetical within group.
  out.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "tree") return -1;
      if (b.type === "tree") return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Read a blob at `<ref>:<path>`. Caps at 5MB and inspects the first 8KB
 * for null bytes to decide text/binary. Binary blobs return only their
 * size; text blobs return the full content.
 */
export async function readBlob(
  workdirPath: string,
  ref: string,
  blobPath: string,
): Promise<BlobResult> {
  // Get size first via cat-file -s <ref>:<path>.
  const sizeRes = await git(["cat-file", "-s", `${ref}:${blobPath}`], workdirPath);
  if (sizeRes.exitCode !== 0) {
    if (
      /Not a valid object name|exists on disk, but not in|does not exist in|fatal: path /i.test(
        sizeRes.stderr,
      )
    ) {
      throw new RepoReadError("not_found", `blob not found: ${blobPath}`);
    }
    throw new RepoReadError("git_failed", sizeRes.stderr || "git cat-file -s failed");
  }
  const size = Number.parseInt(sizeRes.stdout.trim(), 10);
  if (!Number.isFinite(size)) {
    throw new RepoReadError("git_failed", "could not parse blob size");
  }
  if (size > MAX_BLOB_BYTES) {
    return { kind: "too_large", sizeBytes: size };
  }
  // Read the contents via cat-file -p <ref>:<path>. Use the byte buffer
  // directly so binary content can be inspected for null bytes.
  const proc = bunSpawn({
    cmd: ["git", "cat-file", "-p", `${ref}:${blobPath}`],
    cwd: workdirPath,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new RepoReadError("git_failed", "git cat-file -p failed");
  }
  // Binary detection: any null byte in the first 8 KB.
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);
  if (isBinary) {
    return { kind: "binary", sizeBytes: size };
  }
  return { kind: "text", content: new TextDecoder().decode(buf), sizeBytes: size };
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // SVG goes through the image path so the PWA can render it via a data
  // URL (which sandboxes any embedded scripts) rather than inlining HTML.
  svg: "image/svg+xml",
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type ImageBlobResult =
  | { kind: "image"; contentType: string; base64: string; sizeBytes: number }
  | { kind: "too_large"; sizeBytes: number };

/**
 * Read an image blob and return its bytes as base64 plus a guessed
 * content-type. Caller decides whether to invoke this based on the path
 * extension; the daemon refuses non-image extensions to keep the surface
 * narrow. Capped at 2MB — large images aren't useful inline previews.
 */
export async function readImageBlob(
  workdirPath: string,
  ref: string,
  blobPath: string,
): Promise<ImageBlobResult> {
  const ext = (blobPath.split(".").pop() ?? "").toLowerCase();
  const contentType = IMAGE_EXT_TO_MIME[ext];
  if (!contentType) {
    throw new RepoReadError("bad_path", `not a supported image extension: .${ext}`);
  }
  const sizeRes = await git(["cat-file", "-s", `${ref}:${blobPath}`], workdirPath);
  if (sizeRes.exitCode !== 0) {
    if (
      /Not a valid object name|exists on disk, but not in|does not exist in|fatal: path /i.test(
        sizeRes.stderr,
      )
    ) {
      throw new RepoReadError("not_found", `blob not found: ${blobPath}`);
    }
    throw new RepoReadError("git_failed", sizeRes.stderr || "git cat-file -s failed");
  }
  const size = Number.parseInt(sizeRes.stdout.trim(), 10);
  if (!Number.isFinite(size)) {
    throw new RepoReadError("git_failed", "could not parse blob size");
  }
  if (size > MAX_IMAGE_BYTES) {
    return { kind: "too_large", sizeBytes: size };
  }
  const proc = bunSpawn({
    cmd: ["git", "cat-file", "-p", `${ref}:${blobPath}`],
    cwd: workdirPath,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new RepoReadError("git_failed", "git cat-file -p failed");
  }
  return {
    kind: "image",
    contentType,
    base64: buf.toString("base64"),
    sizeBytes: size,
  };
}

export type DiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

export interface DiffFileSummary {
  path: string;
  /** For renames/copies, the source path. Null otherwise. */
  oldPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffSummary {
  base: string;
  target: string;
  /** Merge-base sha when both refs resolve. Null on bad refs (caller throws). */
  mergeBase: string | null;
  files: DiffFileSummary[];
  truncated: boolean;
}

const MAX_DIFF_FILES = 500;
const MAX_DIFF_FILE_BYTES = 1 * 1024 * 1024;

function statusFromCode(code: string): DiffStatus {
  // git --name-status emits: M, A, D, T, C<n>, R<n>
  const c = code[0] ?? "";
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R") return "renamed";
  if (c === "C") return "copied";
  if (c === "T") return "type_changed";
  return "modified";
}

/**
 * Two-ref diff summary using `git diff --name-status -z` + `--numstat -z`.
 * Uses the symmetric three-dot range so both branches' merge-base is used —
 * matches what Github calls a "comparison" rather than "diff".
 */
export async function diffSummary(
  workdirPath: string,
  base: string,
  target: string,
): Promise<DiffSummary> {
  // Resolve merge-base for display; non-fatal if missing.
  let mergeBase: string | null = null;
  const mb = await git(["merge-base", base, target], workdirPath);
  if (mb.exitCode === 0) {
    mergeBase = mb.stdout.trim() || null;
  }

  const range = `${base}...${target}`;

  const nameStatus = await git(["diff", "--name-status", "-z", range], workdirPath);
  if (nameStatus.exitCode !== 0) {
    if (/unknown revision|ambiguous argument|bad revision/i.test(nameStatus.stderr)) {
      throw new RepoReadError("bad_ref", `unknown ref in range: ${range}`);
    }
    throw new RepoReadError("git_failed", nameStatus.stderr || "git diff --name-status failed");
  }

  // -z output: NUL-separated. Renames/copies emit three records: status, old, new.
  const ns = nameStatus.stdout.split("\0").filter((s) => s.length > 0);
  const entries: Array<{ status: DiffStatus; oldPath: string | null; path: string }> = [];
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i] ?? "";
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = ns[i + 1] ?? "";
      const newPath = ns[i + 2] ?? "";
      entries.push({ status: statusFromCode(code), oldPath, path: newPath });
      i += 2;
    } else {
      const path = ns[i + 1] ?? "";
      entries.push({ status: statusFromCode(code), oldPath: null, path });
      i += 1;
    }
  }

  // Numstat — additions/deletions per file (or "-" "-" for binary).
  const numstat = await git(["diff", "--numstat", "-z", range], workdirPath);
  if (numstat.exitCode !== 0) {
    throw new RepoReadError("git_failed", numstat.stderr || "git diff --numstat failed");
  }
  // numstat -z format: "A\tD\tpath\0" per file (renames embed an extra path block).
  // Records use a single trailing NUL per file; renames break path with \0.
  // Easiest robust parse: split on \0 and treat each non-empty token as file row when it has \t.
  type NumRow = { additions: number; deletions: number; binary: boolean; path: string };
  const numRows: NumRow[] = [];
  const tokens = numstat.stdout.split("\0");
  let j = 0;
  while (j < tokens.length) {
    const tok = tokens[j] ?? "";
    if (!tok) {
      j++;
      continue;
    }
    if (!tok.includes("\t")) {
      j++;
      continue;
    }
    const parts = tok.split("\t");
    const a = parts[0] ?? "";
    const d = parts[1] ?? "";
    const pathField = parts[2] ?? "";
    const binary = a === "-" && d === "-";
    if (pathField) {
      numRows.push({
        additions: binary ? 0 : Number(a) || 0,
        deletions: binary ? 0 : Number(d) || 0,
        binary,
        path: pathField,
      });
      j++;
    } else {
      // Rename: this row carries the additions/deletions; next two tokens are old, new path.
      const oldP = tokens[j + 1] ?? "";
      const newP = tokens[j + 2] ?? "";
      numRows.push({
        additions: binary ? 0 : Number(a) || 0,
        deletions: binary ? 0 : Number(d) || 0,
        binary,
        path: newP || oldP,
      });
      j += 3;
    }
  }
  const numByPath = new Map<string, NumRow>();
  for (const r of numRows) numByPath.set(r.path, r);

  const files: DiffFileSummary[] = entries.map((e) => {
    const n = numByPath.get(e.path);
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: e.status,
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
      binary: n?.binary ?? false,
    };
  });

  const truncated = files.length > MAX_DIFF_FILES;
  return {
    base,
    target,
    mergeBase,
    files: truncated ? files.slice(0, MAX_DIFF_FILES) : files,
    truncated,
  };
}

export type DiffFileResult =
  | { kind: "patch"; patch: string; sizeBytes: number }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "too_large"; sizeBytes: number };

/**
 * Unified diff for a single file across the symmetric `base...target` range.
 * Returns the raw patch (no `---/+++` colorization — the client styles it).
 * Caps at 1 MB; binary files don't carry a patch.
 */
export async function diffFile(
  workdirPath: string,
  base: string,
  target: string,
  filePath: string,
): Promise<DiffFileResult> {
  const range = `${base}...${target}`;
  const proc = bunSpawn({
    cmd: ["git", "diff", "--no-color", "--no-ext-diff", "--unified=3", range, "--", filePath],
    cwd: workdirPath,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const stderrBuf = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    if (/unknown revision|ambiguous argument|bad revision/i.test(stderrBuf)) {
      throw new RepoReadError("bad_ref", `unknown ref in range: ${range}`);
    }
    throw new RepoReadError("git_failed", stderrBuf || "git diff failed");
  }
  const sizeBytes = buf.length;
  if (sizeBytes > MAX_DIFF_FILE_BYTES) {
    return { kind: "too_large", sizeBytes };
  }
  // Detect binary diff (git emits "Binary files ... differ" instead of a patch).
  const text = new TextDecoder().decode(buf);
  if (/^Binary files .* differ$/m.test(text)) {
    return { kind: "binary", sizeBytes };
  }
  return { kind: "patch", patch: text, sizeBytes };
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = bunSpawn({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: (err as Error).message };
  }
}
