import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload, X } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

interface Props {
  projectId: string;
  defaultName: string;
  onClose: () => void;
  onPublished: (htmlUrl: string) => void;
}

export function PublishGithubModal({ projectId, defaultName, onClose, onPublished }: Props) {
  const [ownerKind, setOwnerKind] = useState<"user" | "org">("user");
  const [org, setOrg] = useState("");
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [description, setDescription] = useState("");
  const qc = useQueryClient();

  const publish = useMutation({
    mutationFn: () =>
      trpc.projects.publishToGithub.mutate({
        id: projectId,
        ownerKind,
        org: ownerKind === "org" ? org : undefined,
        name,
        visibility,
        description: description || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      onPublished((res as { htmlUrl: string; fullName: string }).htmlUrl);
    },
  });

  const canSubmit = name.length > 0 && (ownerKind === "user" || org.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
    >
      <div className="surface w-full max-w-md max-h-[90vh] overflow-y-auto p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Upload size={16} />
            <span className="display text-lg">publish to GitHub</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost h-8 px-2"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="gh-owner-user"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]"
          >
            owner
          </label>
          <div className="flex items-center gap-3 text-[12.5px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                id="gh-owner-user"
                type="radio"
                name="owner"
                checked={ownerKind === "user"}
                onChange={() => setOwnerKind("user")}
              />
              <span>my account</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="owner"
                checked={ownerKind === "org"}
                onChange={() => setOwnerKind("org")}
              />
              <span>org</span>
            </label>
          </div>
          {ownerKind === "org" ? (
            <input
              type="text"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="org-name"
              className="surface w-full h-9 px-2 mono text-[12px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          ) : null}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="gh-name"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]"
          >
            repo name
          </label>
          <input
            id="gh-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="surface w-full h-9 px-2 mono text-[12px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div className="space-y-1">
          <span className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            visibility
          </span>
          <div className="flex items-center gap-3 text-[12.5px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span>private</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span>public</span>
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="gh-desc"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]"
          >
            description (optional)
          </label>
          <textarea
            id="gh-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="surface w-full px-2 py-1 mono text-[12px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {publish.isError ? (
          <div className="text-[12px] text-[var(--color-verdict-trashed)]">
            {(publish.error as Error).message}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost text-[12px]">
            cancel
          </button>
          <button
            type="button"
            onClick={() => publish.mutate()}
            disabled={!canSubmit || publish.isPending}
            className="btn btn-primary text-[12px]"
          >
            {publish.isPending ? (
              <>
                <Loader2 size={12} className="animate-spin" /> publishing…
              </>
            ) : (
              "create + push"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
