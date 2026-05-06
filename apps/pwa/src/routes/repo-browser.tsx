import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, FileText, Folder, GitBranch, Link2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MarkdownView } from "../components/markdown-view.tsx";
import { MonacoYamlEditor } from "../components/monaco-yaml-editor.tsx";
import { langFromPath } from "../lib/lang-from-extension.ts";
import { trpc } from "../lib/trpc.ts";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

function pathExt(p: string): string {
  return (p.split(".").pop() ?? "").toLowerCase();
}

interface BranchInfo {
  name: string;
  sha: string;
  subject: string;
  ts: number;
  ahead: number | null;
  behind: number | null;
}

interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  ts: number;
}

type TreeEntryType = "blob" | "tree" | "symlink";

interface TreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  mode: string;
  size: number | null;
}

type BlobResult =
  | { kind: "text"; content: string; sizeBytes: number }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "too_large"; sizeBytes: number };

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function RepoBrowser() {
  const { id = "" } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "tree") as "tree" | "commits" | "branches" | "blob" | "diff";
  const ref = params.get("ref") ?? "HEAD";
  const treePath = params.get("path") ?? "";
  const diffBase = params.get("base") ?? "main";
  const diffTarget = params.get("target") ?? ref;

  const setTab = (next: "tree" | "commits" | "branches" | "blob" | "diff") => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    if (next === "branches") p.delete("path");
    setParams(p);
  };

  const setDiffRef = (which: "base" | "target", value: string) => {
    const p = new URLSearchParams(params);
    p.set(which, value);
    p.set("tab", "diff");
    setParams(p);
  };

  const setRef = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("ref", next);
    p.delete("path");
    p.set("tab", "tree");
    setParams(p);
  };

  const navTo = (overrides: Partial<{ tab: string; path: string; ref: string }>) => {
    const p = new URLSearchParams(params);
    if (overrides.tab) p.set("tab", overrides.tab);
    if (overrides.ref) p.set("ref", overrides.ref);
    if (overrides.path !== undefined) p.set("path", overrides.path);
    setParams(p);
  };

  const branches = useQuery({
    queryKey: ["repo.branches", id],
    queryFn: () => trpc.repo.branches.query({ projectId: id }) as unknown as Promise<BranchInfo[]>,
    enabled: id.length > 0,
  });

  return (
    <div className="space-y-3">
      <header>
        <Link
          to={`/projects/${id}`}
          className="mono text-[11px] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] flex items-center gap-1 mb-1"
        >
          <ArrowLeft size={11} /> project
        </Link>
        <h1 className="display text-[18px] leading-tight text-[var(--color-fg)]">code</h1>
        <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 flex items-center gap-2 flex-wrap">
          <RefPicker
            current={ref}
            branches={branches.data ?? []}
            onPick={setRef}
            loading={branches.isLoading}
          />
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-[var(--color-line)]">
        {(["tree", "commits", "branches", "diff"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 mono text-[11px] uppercase tracking-[0.18em] ${
              tab === t || (tab === "blob" && t === "tree")
                ? "text-[var(--color-fg-1)] border-b-2 border-[var(--color-accent)]"
                : "text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "tree" ? (
        <TreeView
          projectId={id}
          treeRef={ref}
          path={treePath}
          onOpenBlob={(p) => navTo({ tab: "blob", path: p })}
          onOpenTree={(p) => navTo({ tab: "tree", path: p })}
        />
      ) : tab === "commits" ? (
        <CommitsView projectId={id} commitRef={ref} />
      ) : tab === "branches" ? (
        <BranchesView branches={branches.data ?? []} loading={branches.isLoading} onPick={setRef} />
      ) : tab === "diff" ? (
        <DiffView
          projectId={id}
          base={diffBase}
          target={diffTarget}
          branches={branches.data ?? []}
          onPickRef={setDiffRef}
        />
      ) : (
        <BlobView projectId={id} blobRef={ref} blobPath={treePath} />
      )}
    </div>
  );
}

function RefPicker({
  current,
  branches,
  onPick,
  loading,
}: {
  current: string;
  branches: BranchInfo[];
  onPick: (next: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chip flex items-center gap-1"
        aria-label="pick branch"
      >
        <GitBranch size={11} />
        <span className="mono text-[11px]">{current}</span>
      </button>
      {open ? (
        <div className="absolute z-20 left-0 top-full mt-1 surface min-w-[220px] max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">loading…</div>
          ) : branches.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">no branches</div>
          ) : (
            branches.map((b) => (
              <button
                type="button"
                key={b.name}
                onClick={() => {
                  onPick(b.name);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 hover:bg-[var(--color-bg-2)] block ${
                  b.name === current ? "bg-[var(--color-bg-2)]" : ""
                }`}
              >
                <div className="mono text-[12px] truncate">{b.name}</div>
                <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                  {b.sha.slice(0, 8)} · {b.subject || "(no subject)"}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function TreeView({
  projectId,
  treeRef,
  path,
  onOpenBlob,
  onOpenTree,
}: {
  projectId: string;
  treeRef: string;
  path: string;
  onOpenBlob: (p: string) => void;
  onOpenTree: (p: string) => void;
}) {
  const tree = useQuery({
    queryKey: ["repo.tree", projectId, treeRef, path],
    queryFn: () =>
      trpc.repo.tree.query({ projectId, ref: treeRef, path }) as unknown as Promise<TreeEntry[]>,
    enabled: projectId.length > 0,
  });

  return (
    <div className="space-y-2">
      <Breadcrumb path={path} onNav={onOpenTree} />
      {tree.isLoading ? (
        <div className="surface px-3 py-3">
          <div className="skel h-3 w-2/3 mb-1.5" />
          <div className="skel h-3 w-1/2" />
        </div>
      ) : tree.error ? (
        <div className="surface px-3 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(tree.error as Error).message}
        </div>
      ) : (tree.data ?? []).length === 0 ? (
        <div className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">empty tree.</div>
      ) : (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {(tree.data ?? []).map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => (e.type === "tree" ? onOpenTree(e.path) : onOpenBlob(e.path))}
                className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-2)] flex items-center gap-2.5"
              >
                {e.type === "tree" ? (
                  <Folder size={13} className="text-[var(--color-accent)] shrink-0" />
                ) : e.type === "symlink" ? (
                  <Link2 size={13} className="text-[var(--color-fg-3)] shrink-0" />
                ) : (
                  <FileText size={13} className="text-[var(--color-fg-3)] shrink-0" />
                )}
                <span className="mono text-[12.5px] truncate flex-1">{e.name}</span>
                {e.size != null ? (
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                    {fmtSize(e.size)}
                  </span>
                ) : null}
                <ChevronRight size={12} className="text-[var(--color-fg-3)] shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Breadcrumb({ path, onNav }: { path: string; onNav: (p: string) => void }) {
  if (!path) {
    return <div className="mono text-[10.5px] text-[var(--color-fg-3)]">/</div>;
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  const accum: string[] = [];
  return (
    <div className="mono text-[11px] text-[var(--color-fg-3)] flex flex-wrap items-center gap-1">
      <button type="button" onClick={() => onNav("")} className="hover:text-[var(--color-fg-1)]">
        /
      </button>
      {segments.map((s, i) => {
        accum.push(s);
        const target = accum.join("/");
        const last = i === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <span className="text-[var(--color-fg-3)]">/</span>
            <button
              type="button"
              onClick={() => onNav(target)}
              disabled={last}
              className={last ? "text-[var(--color-fg-1)]" : "hover:text-[var(--color-fg-1)]"}
            >
              {s}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function CommitsView({ projectId, commitRef }: { projectId: string; commitRef: string }) {
  const [pages, setPages] = useState(1);
  const limit = 50;

  const commits = useQuery({
    queryKey: ["repo.commits", projectId, commitRef, pages],
    queryFn: () =>
      trpc.repo.commits.query({
        projectId,
        ref: commitRef,
        limit: limit * pages,
      }) as unknown as Promise<CommitInfo[]>,
    enabled: projectId.length > 0,
  });

  return (
    <div className="space-y-2">
      {commits.isLoading ? (
        <div className="surface px-3 py-3">
          <div className="skel h-3 w-3/4 mb-1.5" />
          <div className="skel h-3 w-1/2" />
        </div>
      ) : commits.error ? (
        <div className="surface px-3 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(commits.error as Error).message}
        </div>
      ) : (commits.data ?? []).length === 0 ? (
        <div className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">no commits.</div>
      ) : (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {(commits.data ?? []).map((c) => (
            <li key={c.sha} className="px-3 py-2">
              <div className="text-[13px] truncate">{c.subject}</div>
              <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                {c.sha.slice(0, 8)} · {c.author} · {timeAgo(c.ts)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {(commits.data ?? []).length === limit * pages ? (
        <button
          type="button"
          onClick={() => setPages((n) => n + 1)}
          className="btn btn-ghost text-[12px] w-full"
        >
          load more
        </button>
      ) : null}
    </div>
  );
}

function BranchesView({
  branches,
  loading,
  onPick,
}: {
  branches: BranchInfo[];
  loading: boolean;
  onPick: (name: string) => void;
}) {
  if (loading) {
    return (
      <div className="surface px-3 py-3">
        <div className="skel h-3 w-2/3 mb-1.5" />
        <div className="skel h-3 w-1/2" />
      </div>
    );
  }
  if (branches.length === 0) {
    return (
      <div className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">no branches.</div>
    );
  }
  return (
    <ul className="surface divide-y divide-[var(--color-line)]">
      {branches.map((b) => (
        <li key={b.name}>
          <button
            type="button"
            onClick={() => onPick(b.name)}
            className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-2)] flex items-center gap-2"
          >
            <GitBranch size={12} className="text-[var(--color-fg-3)] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="mono text-[12px] truncate">{b.name}</div>
              <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                {b.sha.slice(0, 8)} · {b.subject || "(no subject)"} · {timeAgo(b.ts)}
              </div>
            </div>
            {b.ahead != null && b.behind != null ? (
              <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                +{b.ahead}/-{b.behind}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function BlobView({
  projectId,
  blobRef,
  blobPath,
}: {
  projectId: string;
  blobRef: string;
  blobPath: string;
}) {
  const ext = pathExt(blobPath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return <ImageBlobView projectId={projectId} blobRef={blobRef} blobPath={blobPath} />;
  }
  return <TextBlobView projectId={projectId} blobRef={blobRef} blobPath={blobPath} ext={ext} />;
}

function TextBlobView({
  projectId,
  blobRef,
  blobPath,
  ext,
}: {
  projectId: string;
  blobRef: string;
  blobPath: string;
  ext: string;
}) {
  const blob = useQuery({
    queryKey: ["repo.blob", projectId, blobRef, blobPath],
    queryFn: () =>
      trpc.repo.blob.query({
        projectId,
        ref: blobRef,
        path: blobPath,
      }) as unknown as Promise<BlobResult>,
    enabled: projectId.length > 0 && blobPath.length > 0,
  });
  if (blob.isLoading) {
    return (
      <div className="surface px-3 py-3">
        <div className="skel h-3 w-2/3 mb-1.5" />
        <div className="skel h-3 w-3/4 mb-1.5" />
        <div className="skel h-3 w-1/2" />
      </div>
    );
  }
  if (blob.error) {
    return (
      <div className="surface px-3 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
        {(blob.error as Error).message}
      </div>
    );
  }
  const data = blob.data;
  if (!data) return null;
  const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
  return (
    <div className="space-y-2">
      <div className="mono text-[11px] text-[var(--color-fg-3)] flex items-center gap-2 flex-wrap">
        <FileText size={11} />
        <span className="truncate">{blobPath}</span>
        <span>·</span>
        <span className="tabular-nums">{fmtSize(data.sizeBytes)}</span>
      </div>
      {data.kind === "text" ? (
        isMarkdown ? (
          /* MarkdownView has its own raw/rendered toggle (sticky per-path). */
          <div className="surface px-3 py-3">
            <MarkdownView
              key={`${blobRef}:${blobPath}`}
              source={data.content}
              storageKey={`mdView.code-blob:${blobPath}`}
              defaultMode="rendered"
            />
          </div>
        ) : (
          <MonacoYamlEditor
            key={`${blobRef}:${blobPath}`}
            initialContent={data.content}
            language={langFromPath(blobPath)}
            readOnly
            height="70vh"
            label={blobPath}
          />
        )
      ) : data.kind === "binary" ? (
        <div className="surface px-3 py-6 text-center text-[13px] text-[var(--color-fg-3)]">
          binary file ({fmtSize(data.sizeBytes)}) — preview not available.
        </div>
      ) : (
        <div className="surface px-3 py-6 text-center text-[13px] text-[var(--color-fg-3)]">
          file too large for preview ({fmtSize(data.sizeBytes)}).
        </div>
      )}
    </div>
  );
}

interface ImageBlobResult {
  kind: "image" | "too_large";
  contentType?: string;
  base64?: string;
  sizeBytes: number;
}

function ImageBlobView({
  projectId,
  blobRef,
  blobPath,
}: {
  projectId: string;
  blobRef: string;
  blobPath: string;
}) {
  const blob = useQuery({
    queryKey: ["repo.imageBlob", projectId, blobRef, blobPath],
    queryFn: () =>
      trpc.repo.imageBlob.query({
        projectId,
        ref: blobRef,
        path: blobPath,
      }) as unknown as Promise<ImageBlobResult>,
    enabled: projectId.length > 0 && blobPath.length > 0,
  });
  if (blob.isLoading) {
    return <div className="surface px-3 py-6 skel h-32" />;
  }
  if (blob.error) {
    return (
      <div className="surface px-3 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
        {(blob.error as Error).message}
      </div>
    );
  }
  const data = blob.data;
  if (!data) return null;
  return (
    <div className="space-y-2">
      <div className="mono text-[11px] text-[var(--color-fg-3)] flex items-center gap-2 flex-wrap">
        <FileText size={11} />
        <span className="truncate">{blobPath}</span>
        <span>·</span>
        <span className="tabular-nums">{fmtSize(data.sizeBytes)}</span>
      </div>
      {data.kind === "image" && data.base64 && data.contentType ? (
        <div className="surface px-3 py-4 flex items-center justify-center bg-[var(--color-bg-2)]">
          <img
            src={`data:${data.contentType};base64,${data.base64}`}
            alt={blobPath}
            className="max-w-full max-h-[70vh]"
            style={{ imageRendering: "pixelated" }}
          />
        </div>
      ) : (
        <div className="surface px-3 py-6 text-center text-[13px] text-[var(--color-fg-3)]">
          image too large for preview ({fmtSize(data.sizeBytes)}).
        </div>
      )}
    </div>
  );
}

type DiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

interface DiffFileSummary {
  path: string;
  oldPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface DiffSummaryData {
  base: string;
  target: string;
  mergeBase: string | null;
  files: DiffFileSummary[];
  truncated: boolean;
}

type DiffFilePayload =
  | { kind: "patch"; patch: string; sizeBytes: number }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "too_large"; sizeBytes: number };

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
};

function statusColor(s: DiffStatus): string {
  if (s === "added") return "text-[var(--color-verdict-greenlit)]";
  if (s === "deleted") return "text-[var(--color-verdict-trashed)]";
  if (s === "renamed" || s === "copied") return "text-[var(--color-accent)]";
  return "text-[var(--color-fg-2)]";
}

function DiffView({
  projectId,
  base,
  target,
  branches,
  onPickRef,
}: {
  projectId: string;
  base: string;
  target: string;
  branches: BranchInfo[];
  onPickRef: (which: "base" | "target", value: string) => void;
}) {
  const summary = useQuery({
    queryKey: ["repo.diff", projectId, base, target],
    queryFn: () =>
      trpc.repo.diff.query({ projectId, base, target }) as unknown as Promise<DiffSummaryData>,
    enabled: projectId.length > 0,
  });

  return (
    <div className="space-y-2">
      <div className="surface px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          base
        </span>
        <DiffRefPicker current={base} branches={branches} onPick={(v) => onPickRef("base", v)} />
        <span className="mono text-[11px] text-[var(--color-fg-3)]">…</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          target
        </span>
        <DiffRefPicker
          current={target}
          branches={branches}
          onPick={(v) => onPickRef("target", v)}
        />
      </div>
      {summary.isLoading ? (
        <div className="surface px-3 py-3">
          <div className="skel h-3 w-2/3 mb-1.5" />
          <div className="skel h-3 w-1/2" />
        </div>
      ) : summary.error ? (
        <div className="surface px-3 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(summary.error as Error).message}
        </div>
      ) : !summary.data ? null : summary.data.files.length === 0 ? (
        <div className="surface px-3 py-6 text-center text-[13px] text-[var(--color-fg-3)]">
          no changes between {base} and {target}.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {summary.data.files.length} file{summary.data.files.length === 1 ? "" : "s"} changed
            {summary.data.truncated ? " (truncated to 500)" : ""}
            {summary.data.mergeBase ? ` · merge-base ${summary.data.mergeBase.slice(0, 8)}` : ""}
          </div>
          <ul className="surface divide-y divide-[var(--color-line)]">
            {summary.data.files.map((f) => (
              <DiffFileRow
                key={f.path}
                projectId={projectId}
                base={base}
                target={target}
                file={f}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DiffRefPicker({
  current,
  branches,
  onPick,
}: {
  current: string;
  branches: BranchInfo[];
  onPick: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chip flex items-center gap-1"
      >
        <GitBranch size={11} />
        <span className="mono text-[11px]">{current}</span>
      </button>
      {open ? (
        <div className="absolute z-20 left-0 top-full mt-1 surface min-w-[220px] max-h-[60vh] overflow-y-auto">
          {branches.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">no branches</div>
          ) : (
            branches.map((b) => (
              <button
                type="button"
                key={b.name}
                onClick={() => {
                  onPick(b.name);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 hover:bg-[var(--color-bg-2)] block ${
                  b.name === current ? "bg-[var(--color-bg-2)]" : ""
                }`}
              >
                <div className="mono text-[12px] truncate">{b.name}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiffFileRow({
  projectId,
  base,
  target,
  file,
}: {
  projectId: string;
  base: string;
  target: string;
  file: DiffFileSummary;
}) {
  const [open, setOpen] = useState(false);
  const patch = useQuery({
    queryKey: ["repo.diffFile", projectId, base, target, file.path],
    queryFn: () =>
      trpc.repo.diffFile.query({
        projectId,
        base,
        target,
        path: file.path,
      }) as unknown as Promise<DiffFilePayload>,
    enabled: open && projectId.length > 0,
  });
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-2)] flex items-center gap-2.5"
      >
        <span className={`mono text-[11px] tabular-nums w-4 shrink-0 ${statusColor(file.status)}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="mono text-[12.5px] truncate flex-1">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="mono text-[10.5px] tabular-nums shrink-0 text-[var(--color-verdict-greenlit)]">
          +{file.additions}
        </span>
        <span className="mono text-[10.5px] tabular-nums shrink-0 text-[var(--color-verdict-trashed)]">
          -{file.deletions}
        </span>
        <ChevronRight
          size={12}
          className={`text-[var(--color-fg-3)] shrink-0 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open ? (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-bg-1)]">
          {patch.isLoading ? (
            <div className="px-3 py-2 mono text-[11px] text-[var(--color-fg-3)]">loading…</div>
          ) : patch.error ? (
            <div className="px-3 py-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
              {(patch.error as Error).message}
            </div>
          ) : patch.data?.kind === "patch" ? (
            <DiffPatch patch={patch.data.patch} />
          ) : patch.data?.kind === "binary" ? (
            <div className="px-3 py-2 mono text-[11px] text-[var(--color-fg-3)]">
              binary file — diff not shown.
            </div>
          ) : patch.data?.kind === "too_large" ? (
            <div className="px-3 py-2 mono text-[11px] text-[var(--color-fg-3)]">
              diff too large for preview ({fmtSize(patch.data.sizeBytes)}).
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DiffPatch({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="mono text-[11.5px] leading-[1.5] overflow-x-auto px-3 py-2 whitespace-pre">
      {lines.map((l, i) => {
        let cls = "text-[var(--color-fg-2)]";
        if (l.startsWith("+++") || l.startsWith("---")) {
          cls = "text-[var(--color-fg-3)]";
        } else if (l.startsWith("@@")) {
          cls = "text-[var(--color-accent)]";
        } else if (l.startsWith("+")) {
          cls = "text-[var(--color-verdict-greenlit)]";
        } else if (l.startsWith("-")) {
          cls = "text-[var(--color-verdict-trashed)]";
        } else if (l.startsWith("diff --git") || l.startsWith("index ")) {
          cls = "text-[var(--color-fg-3)]";
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no stable id
          <div key={i} className={cls}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
