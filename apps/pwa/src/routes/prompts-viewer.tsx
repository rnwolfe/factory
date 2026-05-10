import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface ImportSummary {
  perPrompt: Array<{ key: string; added: number; skipped: number; activated: boolean }>;
}

export function PromptsViewer() {
  const list = useQuery({
    queryKey: ["prompts.list"],
    queryFn: () => trpc.prompts.list.query(),
  });

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [activateImported, setActivateImported] = useState(false);

  const importMutation = useMutation({
    mutationFn: async (vars: { yaml: string; activateImported: boolean }) =>
      trpc.prompts.importPack.mutate(vars),
    onSuccess: (result) => {
      setImportSummary(result as ImportSummary);
      setImportError(null);
      queryClient.invalidateQueries({ queryKey: ["prompts.list"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "import failed";
      setImportError(msg);
      setImportSummary(null);
    },
  });

  async function handleExport() {
    setImportError(null);
    setImportSummary(null);
    try {
      const { yaml } = await trpc.prompts.exportPack.query();
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `factory-prompts-${today}.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "export failed");
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const yaml = await file.text();
    importMutation.mutate({ yaml, activateImported });
    // Reset input so re-importing the same file fires onChange again.
    e.target.value = "";
  }

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">prompts</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · active
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        the active prompts the daemon serves to triage, plans, and audits. tap a row to view, edit,
        or roll back to a prior version.
      </p>

      <div className="surface p-3 space-y-2">
        <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          pack
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={handleExport} className="btn h-8 px-3 text-[12px]">
            <Download size={12} /> export
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            disabled={importMutation.isPending}
            className="btn h-8 px-3 text-[12px]"
          >
            <Upload size={12} /> {importMutation.isPending ? "importing…" : "import"}
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg-2)] cursor-pointer">
            <input
              type="checkbox"
              checked={activateImported}
              onChange={(e) => setActivateImported(e.target.checked)}
            />
            <span>activate imported</span>
          </label>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={handleFileChange}
          className="hidden"
        />
        {importError ? (
          <div className="text-[11.5px] text-[var(--color-verdict-trashed)]">{importError}</div>
        ) : null}
        {importSummary ? (
          <div className="text-[11.5px] text-[var(--color-fg-2)] space-y-0.5">
            <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-fg-3)]">
              imported
            </div>
            {importSummary.perPrompt.length === 0 ? (
              <div>nothing to import.</div>
            ) : (
              importSummary.perPrompt.map((p) => (
                <div key={p.key} className="mono">
                  {p.key}: +{p.added}
                  {p.skipped > 0 ? ` (${p.skipped} skipped)` : ""}
                  {p.activated ? " · activated" : ""}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {list.isLoading ? (
        <div className="surface p-3">
          <div className="skel h-4 w-1/2 mb-2" />
          <div className="skel h-3 w-3/4" />
        </div>
      ) : list.isError ? (
        <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
          failed to load prompts.
        </div>
      ) : list.data && list.data.length > 0 ? (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {list.data.map((p) => (
            <li key={p.id}>
              <Link
                to={`/settings/prompts/${encodeURIComponent(p.promptKey)}`}
                className="flex items-center justify-between gap-3 px-3 h-12 hover:bg-[var(--color-bg-2)]"
              >
                <span className="mono text-[12.5px] text-[var(--color-fg-1)] truncate">
                  {p.promptKey}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    {p.lineCount} lines
                  </span>
                  <span className="mono text-[11px] text-[var(--color-fg-3)]">v{p.version}</span>
                  <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="surface p-3 text-[13px] text-[var(--color-fg-3)]">no active prompts.</div>
      )}
    </div>
  );
}
