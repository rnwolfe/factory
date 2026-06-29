import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

const CEREMONIES = ["tinker", "personal", "shared", "production"] as const;
const ROLES = ["owner", "contributor"] as const;
type Ceremony = (typeof CEREMONIES)[number];
type Role = (typeof ROLES)[number];
type SourceKind = "url" | "path";

function deriveSlug(input: string, kind: SourceKind): string {
  if (!input) return "";
  let raw = input;
  if (kind === "url") {
    raw = raw.replace(/\.git$/, "").replace(/\/+$/, "");
    raw = raw.split(/[/:]/).filter(Boolean).pop() ?? "";
  } else {
    // last path segment
    raw = raw.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function ImportProject() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [kind, setKind] = useState<SourceKind>("url");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ceremony, setCeremony] = useState<Ceremony>("tinker");
  const [role, setRole] = useState<Role>("owner");

  const sourceValue = kind === "url" ? url : path;
  const derivedSlug = useMemo(() => deriveSlug(sourceValue, kind), [sourceValue, kind]);
  const effectiveSlug = slug.trim() || derivedSlug;

  const submit = useMutation({
    mutationFn: () =>
      trpc.projects.import.mutate({
        source:
          kind === "url" ? { kind: "url", url: url.trim() } : { kind: "path", path: path.trim() },
        name: name.trim() || undefined,
        slug: slug.trim() || undefined,
        ceremony,
        role,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      // tier ≥ personal → suggest deepen on the project page (banner there);
      // for now we just land on the project.
      nav(`/projects/${res.projectId}`);
    },
  });

  const can =
    sourceValue.trim().length > 0 &&
    !submit.isPending &&
    (kind !== "url" || /^(https:\/\/|git@)/.test(url.trim())) &&
    (kind !== "path" || path.trim().startsWith("/"));

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="surface px-4 py-3 flex items-center gap-2">
        <Link to="/projects" className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]">
          <ArrowLeft size={14} />
        </Link>
        <div className="display text-[16px] text-[var(--color-fg)]">import project</div>
      </div>

      <div className="surface p-4 space-y-4">
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
            source
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setKind("url")}
              className={cn(
                "chip",
                kind === "url" ? "chip-working" : "hover:border-[var(--color-line-bright)]",
              )}
            >
              clone url
            </button>
            <button
              type="button"
              onClick={() => setKind("path")}
              className={cn(
                "chip",
                kind === "path" ? "chip-working" : "hover:border-[var(--color-line-bright)]",
              )}
            >
              local path
            </button>
          </div>
        </div>

        {kind === "url" ? (
          <div>
            <label
              htmlFor="import-url"
              className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
            >
              git url
            </label>
            <input
              id="import-url"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://github.com/org/repo or git@github.com:org/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] mono"
            />
            <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">
              https:// or git@ only — no file://. private clones must use local-path mode.
            </p>
          </div>
        ) : (
          <div>
            <label
              htmlFor="import-path"
              className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
            >
              absolute path
            </label>
            <input
              id="import-path"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="/home/you/code/some-repo"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] mono"
            />
            <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">
              must be absolute and inside $HOME. existing files are not modified.
            </p>
          </div>
        )}

        <div>
          <label
            htmlFor="import-name"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            display name <span className="normal-case text-[var(--color-fg-3)]">(optional)</span>
          </label>
          <input
            id="import-name"
            type="text"
            placeholder={effectiveSlug || "auto-derived from source"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div>
          <label
            htmlFor="import-slug"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            slug <span className="normal-case text-[var(--color-fg-3)]">(optional)</span>
          </label>
          <input
            id="import-slug"
            type="text"
            placeholder={derivedSlug || "auto-derived"}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] mono"
          />
        </div>

        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
            role
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={cn(
                  "chip",
                  role === r ? "chip-working" : "hover:border-[var(--color-line-bright)]",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2">
            owner: you set vision/architecture. contributor: you're working inside someone else's
            project — vision plan + filter are skipped.
          </p>
        </div>

        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
            ceremony
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CEREMONIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCeremony(c)}
                className={cn(
                  "chip",
                  ceremony === c ? "chip-working" : "hover:border-[var(--color-line-bright)]",
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2">
            tinker skips deepening. personal+ projects get the vision/audit treatment.
          </p>
        </div>

        {submit.isError ? (
          <div className="text-[12.5px] text-[var(--color-verdict-trashed)] mono">
            {(submit.error as Error).message}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={!can}
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? kind === "url"
              ? "cloning…"
              : "registering…"
            : kind === "url"
              ? "clone & import"
              : "register existing"}
          {!submit.isPending && <ArrowRight size={14} />}
        </button>
      </div>

      <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
        url clones land in <span className="text-[var(--color-fg-1)]">~/.factory/projects/</span>.
        path imports point at your existing checkout. either way the .factory/ skeleton is added
        without touching your repo files.
      </p>
    </div>
  );
}
