import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Layers, Loader2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface TemplateVariable {
  key: string;
  label: string;
  description: string;
  required: boolean;
  default: string | null;
}

interface TemplateDraft {
  kind: "task_template";
  name: string;
  description: string;
  titlePattern: string;
  labels: string[];
  priority: "low" | "med" | "high";
  estimate: "small" | "medium" | "large";
  variables: TemplateVariable[];
  sections: Array<{ heading: string; kind: "static" | "agent"; body: string }>;
}

interface TemplateView {
  id: string;
  slug: string;
  name: string;
  description: string;
  draft: TemplateDraft;
}

/**
 * Two-step modal: pick a template, then fill the variable form and submit.
 * On success, navigates to the newly-created task. The modal closes itself
 * after success — no separate "task created" affordance, since the route
 * change is the affordance.
 *
 * The agent-render toggle is exposed inline; defaults to `true` since the
 * primary value of templates is per-project tailoring. Operators who want
 * the pure static experience can flip it off.
 */
export function InstantiateTemplateModal({
  projectId,
  onClose,
  /**
   * When set, the modal opens directly into the variable form for this
   * template's slug — bypassing the picker. Used by the project-header
   * "release" button which always wants the release-project template.
   */
  preselectSlug,
}: {
  projectId: string;
  onClose: () => void;
  preselectSlug?: string;
}) {
  const [selected, setSelected] = useState<TemplateView | null>(null);

  // Pre-load the preselected template, then auto-advance to the form.
  const preload = useQuery({
    queryKey: ["taskTemplates.bySlug", preselectSlug ?? "_skip"],
    queryFn: () =>
      trpc.taskTemplates.bySlug.query({
        slug: preselectSlug ?? "",
      }) as Promise<TemplateView | null>,
    enabled: !!preselectSlug && !selected,
    staleTime: 30_000,
  });
  if (preselectSlug && !selected && preload.data) {
    setSelected(preload.data);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={selected ? `Instantiate template "${selected.name}"` : "Pick a task template"}
    >
      <div className="surface w-full max-w-md max-h-[90vh] overflow-y-auto p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {selected ? (
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="back to template list"
                className="text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"
              >
                <ChevronLeft size={16} />
              </button>
            ) : (
              <Layers size={16} />
            )}
            <span className="display text-lg">{selected ? selected.name : "task templates"}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"
          >
            <X size={16} />
          </button>
        </div>

        {selected ? (
          <InstantiateForm
            template={selected}
            projectId={projectId}
            onClose={onClose}
            onBack={() => setSelected(null)}
          />
        ) : (
          <TemplateList onSelect={setSelected} />
        )}
      </div>
    </div>
  );
}

function TemplateList({ onSelect }: { onSelect: (t: TemplateView) => void }) {
  const list = useQuery({
    queryKey: ["taskTemplates.list"],
    queryFn: () => trpc.taskTemplates.list.query() as Promise<TemplateView[]>,
    staleTime: 30_000,
  });

  if (list.isLoading) {
    return (
      <div className="space-y-2">
        <div className="skel h-12 rounded" />
        <div className="skel h-12 rounded" />
      </div>
    );
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="px-2 py-6 text-center">
        <p className="text-[13px] text-[var(--color-fg-2)]">no templates authored yet</p>
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2">
          create one from the inbox: <span className="text-[var(--color-fg-2)]">new template</span>
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {list.data.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onSelect(t)}
            className="w-full text-left surface px-3 py-2.5 hover:bg-[var(--color-bg-2)] transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] text-[var(--color-fg)] truncate flex-1">{t.name}</span>
              <span className="chip text-[10.5px]">{t.draft.estimate}</span>
            </div>
            {t.description ? (
              <p className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                {t.description}
              </p>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function InstantiateForm({
  template,
  projectId,
  onClose,
  onBack,
}: {
  template: TemplateView;
  projectId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const v of template.draft.variables) {
      out[v.key] = v.default ?? "";
    }
    return out;
  });
  const [renderWithAgent, setRenderWithAgent] = useState(true);
  const qc = useQueryClient();
  const nav = useNavigate();
  const hasAgentSection = template.draft.sections.some((s) => s.kind === "agent");

  const instantiate = useMutation({
    mutationFn: () =>
      trpc.taskTemplates.instantiate.mutate({
        templateSlug: template.slug,
        projectId,
        variables: values,
        renderWithAgent: hasAgentSection ? renderWithAgent : false,
      }) as Promise<{ taskId: string }>,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      onClose();
      nav(`/projects/${projectId}/tasks/${res.taskId}`);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    instantiate.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {template.description ? (
        <p className="text-[13px] text-[var(--color-fg-2)] leading-relaxed">
          {template.description}
        </p>
      ) : null}

      {template.draft.variables.length === 0 ? (
        <p className="mono text-[10.5px] text-[var(--color-fg-3)]">
          this template has no variables — just confirm.
        </p>
      ) : (
        <div className="space-y-2.5">
          {template.draft.variables.map((v) => (
            <label key={v.key} className="block">
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] text-[var(--color-fg-1)]">{v.label}</span>
                {v.required ? null : (
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)]">optional</span>
                )}
              </div>
              {v.description ? (
                <p className="mono text-[10.5px] text-[var(--color-fg-3)] mb-1">{v.description}</p>
              ) : null}
              <input
                type="text"
                value={values[v.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                placeholder={v.default ?? ""}
                required={v.required && (v.default === null || v.default.length === 0)}
                className="mono text-[12px] w-full bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1.5"
              />
            </label>
          ))}
        </div>
      )}

      {hasAgentSection ? (
        <label className="flex items-start gap-2 text-[12.5px] text-[var(--color-fg-1)]">
          <input
            type="checkbox"
            checked={renderWithAgent}
            onChange={(e) => setRenderWithAgent(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            tailor agent sections to this project
            <span className="block mono text-[10.5px] text-[var(--color-fg-3)] mt-0.5">
              {template.draft.sections.filter((s) => s.kind === "agent").length} section(s) will get
              a model invocation to fit the project's stack and conventions.
            </span>
          </span>
        </label>
      ) : null}

      {instantiate.isError ? (
        <div className="mono text-[10.5px] text-[var(--color-verdict-trashed)] leading-relaxed">
          {(instantiate.error as Error).message}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="btn btn-ghost text-[12px]"
          disabled={instantiate.isPending}
        >
          back
        </button>
        <div className="flex-1" />
        <button type="submit" className="btn text-[12px]" disabled={instantiate.isPending}>
          {instantiate.isPending ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              {renderWithAgent && hasAgentSection ? "rendering…" : "creating…"}
            </>
          ) : (
            "create task"
          )}
        </button>
      </div>
    </form>
  );
}
