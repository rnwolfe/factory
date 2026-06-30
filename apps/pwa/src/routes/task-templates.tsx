import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Layers, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface TemplateView {
  id: string;
  slug: string;
  name: string;
  description: string;
  draft: {
    kind: "task_template";
    name: string;
    description: string;
    titlePattern: string;
    labels: string[];
    priority: "low" | "med" | "high";
    estimate: "small" | "medium" | "large";
    variables: Array<{
      key: string;
      label: string;
      description: string;
      required: boolean;
      default: string | null;
    }>;
    sections: Array<{ heading: string; kind: "static" | "agent"; body: string }>;
  };
  archivedAt: number | null;
  updatedAt: number;
}

/**
 * Settings → task templates list page. The picker on the project page is
 * the primary instantiation surface; this page is for managing the
 * library — reviewing what exists, archiving stale templates, jumping
 * into the form-editor for tweaks.
 *
 * New templates are authored via the inbox plan-iterate flow (where the
 * agent helps shape the variable set + section breakdown). This page
 * doesn't expose "create" — templates only appear here after a freeze.
 */
export function TaskTemplates() {
  const list = useQuery({
    queryKey: ["taskTemplates.list"],
    queryFn: () => trpc.taskTemplates.list.query() as Promise<TemplateView[]>,
    refetchInterval: 30_000,
  });
  const nav = useNavigate();
  const [draftGoal, setDraftGoal] = useState("");
  const startDraft = useMutation({
    mutationFn: () =>
      (
        trpc.plans as unknown as {
          startTaskTemplate: { mutate: (i: { goal: string }) => Promise<{ planId: string }> };
        }
      ).startTaskTemplate.mutate({ goal: draftGoal.trim() }),
    onSuccess: (res) => {
      nav(`/plans/${res.planId}`);
    },
  });

  return (
    <div className="space-y-4 md:max-w-3xl md:mx-auto">
      <Link
        to="/settings"
        className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
      >
        <ArrowLeft size={11} /> settings
      </Link>
      <header>
        <div className="flex items-center gap-2 px-1">
          <Layers size={14} className="text-[var(--color-fg-2)]" />
          <span className="display text-lg text-[var(--color-fg)]">task templates</span>
        </div>
        <p className="px-1 mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
          Reusable, cross-project task blueprints. Instantiate against any project from the project
          header's <span className="mono text-[11px]">from template</span> button.
        </p>
      </header>

      <section className="surface px-3 py-3 space-y-2">
        <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          new template
        </div>
        <p className="text-[12.5px] text-[var(--color-fg-2)] leading-relaxed">
          State the goal — what use case this template is for. The agent helps shape variables and
          sections; you freeze when it's right.
        </p>
        <textarea
          value={draftGoal}
          onChange={(e) => setDraftGoal(e.target.value)}
          rows={2}
          placeholder="e.g. add a release-notes / what's-new flow to a web project"
          className="mono text-[12px] w-full bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1.5"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => startDraft.mutate()}
            disabled={startDraft.isPending || draftGoal.trim().length < 4}
            className="btn text-[12px] flex items-center gap-1.5"
          >
            {startDraft.isPending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Plus size={11} />
            )}
            draft with agent
          </button>
          {startDraft.isError ? (
            <span className="mono text-[10.5px] text-[var(--color-verdict-trashed)]">
              {(startDraft.error as Error).message}
            </span>
          ) : null}
        </div>
      </section>

      <section>
        <div className="px-1 mb-1.5 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          library
        </div>
        {list.isLoading ? (
          <div className="surface px-3 py-3 mono text-[12px] text-[var(--color-fg-3)]">
            loading…
          </div>
        ) : !list.data || list.data.length === 0 ? (
          <div className="surface px-3 py-3 mono text-[12.5px] text-[var(--color-fg-3)]">
            no templates yet — draft one above.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {list.data.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/settings/task-templates/${t.slug}`}
                  className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] text-[var(--color-fg)] truncate flex-1">
                      {t.name}
                    </span>
                    <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                      {t.draft.estimate}
                    </span>
                    <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                      {t.draft.variables.length} var{t.draft.variables.length === 1 ? "" : "s"}
                    </span>
                    <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
                  </div>
                  {t.description ? (
                    <p className="mt-0.5 mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                      {t.description}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface TaskTemplateEditorProps {
  slug: string;
}

/**
 * Form editor for a single template. Operators who already know what they
 * want use this surface; the plan-iterate flow is for "help me think about
 * this." Both write to the same task_templates row — the editor's save
 * doesn't bump the slug, so deep links stay stable.
 */
export function TaskTemplateEditor({ slug }: TaskTemplateEditorProps) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ["taskTemplates.bySlug", slug],
    queryFn: () => trpc.taskTemplates.bySlug.query({ slug }) as Promise<TemplateView | null>,
    staleTime: 30_000,
  });

  // Local form state hydrated from the query.
  const [draft, setDraft] = useState<TemplateView["draft"] | null>(null);
  if (q.data && !draft) setDraft(q.data.draft);

  const save = useMutation({
    mutationFn: () => {
      if (!q.data || !draft) throw new Error("template not loaded");
      return trpc.taskTemplates.update.mutate({ id: q.data.id, draft });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["taskTemplates.list"] });
      qc.invalidateQueries({ queryKey: ["taskTemplates.bySlug", slug] });
    },
  });

  const archive = useMutation({
    mutationFn: () => {
      if (!q.data) throw new Error("template not loaded");
      return trpc.taskTemplates.archive.mutate({ id: q.data.id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["taskTemplates.list"] });
      nav("/settings/task-templates");
    },
  });

  if (q.isLoading) {
    return <div className="px-3 mono text-[12px] text-[var(--color-fg-3)]">loading…</div>;
  }
  if (!q.data || !draft) {
    return (
      <div className="px-3 py-6 text-center">
        <p className="text-[13px] text-[var(--color-fg-2)]">template not found</p>
        <Link
          to="/settings/task-templates"
          className="mono text-[11px] text-[var(--color-fg-1)] underline mt-2 inline-block"
        >
          back to library
        </Link>
      </div>
    );
  }

  const updateField = <K extends keyof TemplateView["draft"]>(
    key: K,
    value: TemplateView["draft"][K],
  ) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div className="space-y-4 md:max-w-3xl md:mx-auto">
      <Link
        to="/settings/task-templates"
        className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
      >
        <ArrowLeft size={11} /> templates
      </Link>
      <header className="surface px-3 py-3 space-y-2">
        <Field label="name" value={draft.name} onChange={(v) => updateField("name", v)} />
        <Field
          label="description"
          value={draft.description}
          onChange={(v) => updateField("description", v)}
          hint="one-line summary, shown in the picker"
        />
        <Field
          label="title pattern"
          value={draft.titlePattern}
          onChange={(v) => updateField("titlePattern", v)}
          hint="task title; use {var} substitutions like {projectName}"
        />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
              priority
            </div>
            <div className="flex gap-1">
              {(["low", "med", "high"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => updateField("priority", p)}
                  className={`chip mono text-[11px] ${draft.priority === p ? "chip-working" : ""}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
              estimate
            </div>
            <div className="flex gap-1">
              {(["small", "medium", "large"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => updateField("estimate", e)}
                  className={`chip mono text-[11px] ${draft.estimate === e ? "chip-working" : ""}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <section className="surface px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            variables ({draft.variables.length})
          </span>
          <button
            type="button"
            onClick={() =>
              updateField("variables", [
                ...draft.variables,
                {
                  key: "new_var",
                  label: "",
                  description: "",
                  required: true,
                  default: null,
                },
              ])
            }
            className="btn btn-ghost text-[11px]"
          >
            <Plus size={11} /> variable
          </button>
        </div>
        {draft.variables.map((v, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor row; key collisions allowed
            key={`var-${i}-${v.key}`}
            className="px-2 py-2 border border-[var(--color-line)] rounded space-y-1.5"
          >
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={v.key}
                onChange={(e) =>
                  updateField(
                    "variables",
                    draft.variables.map((x, j) => (i === j ? { ...x, key: e.target.value } : x)),
                  )
                }
                placeholder="snake_case_key"
                className="mono text-[12px] flex-1 bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
              />
              <input
                type="text"
                value={v.label}
                onChange={(e) =>
                  updateField(
                    "variables",
                    draft.variables.map((x, j) => (i === j ? { ...x, label: e.target.value } : x)),
                  )
                }
                placeholder="operator label"
                className="mono text-[12px] flex-1 bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
              />
              <button
                type="button"
                onClick={() =>
                  updateField(
                    "variables",
                    draft.variables.filter((_, j) => i !== j),
                  )
                }
                aria-label="remove variable"
                className="btn btn-ghost text-[11px] !h-7 !px-1.5 text-[var(--color-verdict-trashed)]"
              >
                <Trash2 size={11} />
              </button>
            </div>
            <input
              type="text"
              value={v.description}
              onChange={(e) =>
                updateField(
                  "variables",
                  draft.variables.map((x, j) =>
                    i === j ? { ...x, description: e.target.value } : x,
                  ),
                )
              }
              placeholder="hint shown under the input"
              className="mono text-[11.5px] w-full bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
            />
            <div className="flex items-center gap-2 mono text-[10.5px] text-[var(--color-fg-3)]">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={v.required}
                  onChange={(e) =>
                    updateField(
                      "variables",
                      draft.variables.map((x, j) =>
                        i === j ? { ...x, required: e.target.checked } : x,
                      ),
                    )
                  }
                />
                required
              </label>
              <input
                type="text"
                value={v.default ?? ""}
                onChange={(e) =>
                  updateField(
                    "variables",
                    draft.variables.map((x, j) =>
                      i === j
                        ? { ...x, default: e.target.value.length > 0 ? e.target.value : null }
                        : x,
                    ),
                  )
                }
                placeholder="default value (optional)"
                className="mono text-[11.5px] flex-1 bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
              />
            </div>
          </div>
        ))}
      </section>

      <section className="surface px-3 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            sections ({draft.sections.length})
          </span>
          <button
            type="button"
            onClick={() =>
              updateField("sections", [
                ...draft.sections,
                { heading: "New section", kind: "static", body: "" },
              ])
            }
            className="btn btn-ghost text-[11px]"
          >
            <Plus size={11} /> section
          </button>
        </div>
        {draft.sections.map((s, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor row; key collisions allowed
            key={`section-${i}-${s.heading}`}
            className="px-2 py-2 border border-[var(--color-line)] rounded space-y-1.5"
          >
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={s.heading}
                onChange={(e) =>
                  updateField(
                    "sections",
                    draft.sections.map((x, j) => (i === j ? { ...x, heading: e.target.value } : x)),
                  )
                }
                placeholder="heading"
                className="mono text-[12px] flex-1 bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
              />
              <button
                type="button"
                onClick={() =>
                  updateField(
                    "sections",
                    draft.sections.map((x, j) =>
                      i === j ? { ...x, kind: x.kind === "static" ? "agent" : "static" } : x,
                    ),
                  )
                }
                className={`chip mono text-[10.5px] ${s.kind === "agent" ? "chip-working" : ""}`}
                title="toggle static / agent-rendered"
              >
                {s.kind}
              </button>
              <button
                type="button"
                onClick={() =>
                  updateField(
                    "sections",
                    draft.sections.filter((_, j) => i !== j),
                  )
                }
                aria-label="remove section"
                className="btn btn-ghost text-[11px] !h-7 !px-1.5 text-[var(--color-verdict-trashed)]"
              >
                <Trash2 size={11} />
              </button>
            </div>
            <textarea
              value={s.body}
              rows={5}
              onChange={(e) =>
                updateField(
                  "sections",
                  draft.sections.map((x, j) => (i === j ? { ...x, body: e.target.value } : x)),
                )
              }
              placeholder={
                s.kind === "agent"
                  ? "instruction to the rendering agent"
                  : "markdown body with {var} substitutions"
              }
              className="mono text-[11.5px] w-full bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1.5"
            />
          </div>
        ))}
      </section>

      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="btn text-[12px] flex items-center gap-1.5"
        >
          {save.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
          save
        </button>
        {save.isError ? (
          <span className="mono text-[10.5px] text-[var(--color-verdict-trashed)]">
            {(save.error as Error).message}
          </span>
        ) : save.isSuccess ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-2)]">saved</span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => archive.mutate()}
          disabled={archive.isPending}
          className="btn btn-ghost text-[11px] !h-7 text-[var(--color-verdict-trashed)]"
          title="hide from the picker; row kept for audit"
        >
          archive
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mono text-[12px] w-full bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1.5"
      />
      {hint ? <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-0.5">{hint}</p> : null}
    </label>
  );
}

/** Route wrapper — reads `slug` from useParams and delegates. */
export function TaskTemplateEditorRoute() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <TaskTemplateEditor slug={slug} />;
}
