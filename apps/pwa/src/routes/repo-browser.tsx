import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, FileText, Folder, GitBranch, Link2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { MonacoYamlEditor } from "../components/monaco-yaml-editor.tsx";
import { langFromPath } from "../lib/lang-from-extension.ts";
import { trpc } from "../lib/trpc.ts";

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
  const tab = (params.get("tab") ?? "tree") as "tree" | "commits" | "branches" | "blob";
  const ref = params.get("ref") ?? "HEAD";
  const treePath = params.get("path") ?? "";

  const setTab = (next: "tree" | "commits" | "branches" | "blob") => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    if (next === "branches") p.delete("path");
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
        {(["tree", "commits", "branches"] as const).map((t) => (
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
  return (
    <div className="space-y-2">
      <div className="mono text-[11px] text-[var(--color-fg-3)] flex items-center gap-2 flex-wrap">
        <FileText size={11} />
        <span className="truncate">{blobPath}</span>
        <span>·</span>
        <span className="tabular-nums">{fmtSize(data.sizeBytes)}</span>
      </div>
      {data.kind === "text" ? (
        <MonacoYamlEditor
          key={`${blobRef}:${blobPath}`}
          initialContent={data.content}
          language={langFromPath(blobPath)}
          readOnly
          height="70vh"
          label={blobPath}
        />
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
