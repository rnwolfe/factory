import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, History, Loader2, Pencil, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MonacoYamlEditor } from "../components/monaco-yaml-editor.tsx";
import { trpc } from "../lib/trpc.ts";

interface RubricRow {
  id: string;
  rubricKey: string;
  version: number;
  yaml: string;
  promptKey: string;
  active: boolean;
  createdAt: number;
  message: string | null;
}

interface HistoryRow {
  id: string;
  rubricKey: string;
  version: number;
  active: boolean;
  createdAt: number;
  message: string | null;
}

type Mode = "view" | "edit" | "history";

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function RubricDetail() {
  const { key = "" } = useParams<{ key: string }>();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);

  const active = useQuery({
    queryKey: ["rubrics.get", key, "active"],
    queryFn: () => trpc.rubrics.get.query({ key }) as unknown as Promise<RubricRow | null>,
    enabled: key.length > 0,
  });

  const history = useQuery({
    queryKey: ["rubrics.history", key],
    queryFn: () => trpc.rubrics.history.query({ key }) as unknown as Promise<HistoryRow[]>,
    enabled: key.length > 0 && mode === "history",
  });

  const previewRow = useQuery({
    queryKey: ["rubrics.get", key, previewVersion],
    queryFn: () =>
      trpc.rubrics.get.query({
        key,
        version: previewVersion ?? undefined,
      }) as unknown as Promise<RubricRow | null>,
    enabled: previewVersion !== null,
  });

  const upsert = useMutation({
    mutationFn: (yaml: string) => trpc.rubrics.upsertVersion.mutate({ rubricKey: key, yaml }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubrics.get", key, "active"] });
      qc.invalidateQueries({ queryKey: ["rubrics.history", key] });
      qc.invalidateQueries({ queryKey: ["rubrics.list"] });
      setMode("view");
      setDraft(null);
    },
  });

  const activate = useMutation({
    mutationFn: (version: number) =>
      trpc.rubrics.activateVersion.mutate({ rubricKey: key, version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubrics.get", key, "active"] });
      qc.invalidateQueries({ queryKey: ["rubrics.history", key] });
      qc.invalidateQueries({ queryKey: ["rubrics.list"] });
      setPreviewVersion(null);
    },
  });

  useEffect(() => {
    if (mode === "edit" && draft === null && active.data) {
      setDraft(active.data.yaml);
    }
  }, [mode, draft, active.data]);

  if (!key) {
    return (
      <div className="surface p-3 text-[13px] text-[var(--color-fg-2)]">
        missing rubric key.{" "}
        <Link to="/settings/rubrics" className="text-[var(--color-accent)] underline">
          back
        </Link>
      </div>
    );
  }

  if (active.isLoading) {
    return (
      <div className="surface p-3">
        <div className="skel h-4 w-1/2 mb-2" />
        <div className="skel h-3 w-3/4" />
      </div>
    );
  }

  if (active.isError || !active.data) {
    return (
      <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
        rubric {key} not found.
      </div>
    );
  }

  const a = active.data;

  return (
    <div className="space-y-3 pb-4 md:max-w-3xl md:mx-auto">
      <header className="surface p-4">
        <Link
          to="/settings/rubrics"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> rubrics
        </Link>
        <h1 className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2 break-all">
          {key}
        </h1>
        <div className="mono text-[11px] text-[var(--color-fg-3)] mt-1 flex items-center gap-2 flex-wrap">
          <span className="chip chip-greenlit">v{a.version} active</span>
          <span>·</span>
          <span>updated {fmtDate(a.createdAt)}</span>
          <span>·</span>
          <span>prompt: {a.promptKey}</span>
        </div>

        {mode === "view" ? (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="btn btn-ghost text-[12px]"
              onClick={() => setMode("edit")}
            >
              <Pencil size={12} /> edit
            </button>
            <button
              type="button"
              className="btn btn-ghost text-[12px]"
              onClick={() => setMode("history")}
            >
              <History size={12} /> history
            </button>
          </div>
        ) : null}

        {mode === "edit" ? (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="btn btn-primary text-[12px]"
              disabled={upsert.isPending || draft === null || draft === a.yaml}
              onClick={() => draft !== null && upsert.mutate(draft)}
            >
              {upsert.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> saving…
                </>
              ) : (
                <>
                  <Save size={12} /> save as v{a.version + 1}
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost text-[12px]"
              onClick={() => {
                setMode("view");
                setDraft(null);
              }}
            >
              <X size={12} /> cancel
            </button>
            {upsert.isError ? (
              <span className="mono text-[11px] text-[var(--color-verdict-trashed)]">
                {(upsert.error as Error).message}
              </span>
            ) : null}
          </div>
        ) : null}

        {mode === "history" ? (
          <div className="mt-3">
            <button
              type="button"
              className="btn btn-ghost text-[12px]"
              onClick={() => {
                setMode("view");
                setPreviewVersion(null);
              }}
            >
              <ArrowLeft size={12} /> back to active
            </button>
          </div>
        ) : null}

        <p className="mt-3 mono text-[10.5px] text-[var(--color-fg-3)] leading-relaxed">
          edits create a new version. activate from the history panel to make a version live.
          invalid yaml is rejected — fix the shape before saving.
        </p>
      </header>

      {mode === "edit" ? (
        <MonacoYamlEditor
          initialContent={a.yaml}
          onChange={setDraft}
          language="yaml"
          label={`edit ${key}`}
          height="65vh"
        />
      ) : null}

      {mode === "view" ? (
        <pre className="surface p-3 mono text-[11.5px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words overflow-x-auto">
          {a.yaml}
        </pre>
      ) : null}

      {mode === "history" ? (
        <HistoryPanel
          history={history.data ?? []}
          loading={history.isLoading}
          previewVersion={previewVersion}
          previewRow={previewRow.data ?? null}
          previewLoading={previewRow.isLoading}
          onSelect={setPreviewVersion}
          onActivate={(v) => activate.mutate(v)}
          activating={activate.isPending}
          activatingVersion={activate.variables ?? null}
          activeVersion={a.version}
        />
      ) : null}

      {activate.isError ? (
        <div className="surface p-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(activate.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

interface HistoryPanelProps {
  history: HistoryRow[];
  loading: boolean;
  previewVersion: number | null;
  previewRow: RubricRow | null;
  previewLoading: boolean;
  onSelect: (v: number) => void;
  onActivate: (v: number) => void;
  activating: boolean;
  activatingVersion: number | null;
  activeVersion: number;
}

function HistoryPanel({
  history,
  loading,
  previewVersion,
  previewRow,
  previewLoading,
  onSelect,
  onActivate,
  activating,
  activatingVersion,
  activeVersion,
}: HistoryPanelProps) {
  if (loading) {
    return (
      <div className="surface p-3">
        <div className="skel h-3 w-1/3 mb-2" />
        <div className="skel h-3 w-1/2" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="surface divide-y divide-[var(--color-line)]">
        {history.map((h) => {
          const isActive = h.version === activeVersion;
          const isPreviewing = h.version === previewVersion;
          return (
            <li key={h.id}>
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => onSelect(h.version)}
                  className={`flex-1 min-w-0 text-left flex items-center gap-2 ${
                    isPreviewing ? "text-[var(--color-fg)]" : "text-[var(--color-fg-1)]"
                  }`}
                  aria-pressed={isPreviewing}
                >
                  <span className="mono text-[12px] tabular-nums w-12">v{h.version}</span>
                  {isActive ? <span className="chip chip-greenlit">active</span> : null}
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {fmtDate(h.createdAt)}
                  </span>
                </button>
                {!isActive ? (
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px] !h-8 !px-2"
                    onClick={() => onActivate(h.version)}
                    disabled={activating}
                    aria-label={`activate v${h.version}`}
                  >
                    {activating && activatingVersion === h.version ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <RotateCcw size={11} />
                    )}
                    activate
                  </button>
                ) : (
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] flex items-center gap-1">
                    <Check size={11} /> in use
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {history.length === 0 ? (
          <li className="px-3 py-2.5 text-[12.5px] text-[var(--color-fg-3)]">no history yet.</li>
        ) : null}
      </ul>

      {previewVersion !== null ? (
        <div className="surface p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              preview · v{previewVersion}
            </span>
            <div className="hairline flex-1" />
          </div>
          {previewLoading ? (
            <div className="skel h-3 w-1/3" />
          ) : previewRow ? (
            <pre className="mono text-[11.5px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words overflow-x-auto">
              {previewRow.yaml}
            </pre>
          ) : (
            <div className="mono text-[11px] text-[var(--color-fg-3)]">version not found.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
