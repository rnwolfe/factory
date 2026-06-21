import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

const CEREMONIES = ["tinker", "personal", "shared", "production"] as const;
const ROLES = ["owner", "contributor"] as const;
const ESTIMATES = ["small", "medium", "large"] as const;
type Ceremony = (typeof CEREMONIES)[number];
type Role = (typeof ROLES)[number];
type Estimate = (typeof ESTIMATES)[number];

interface DecompositionTask {
  title: string;
  estimate: Estimate;
  acceptance: string[];
}

interface Decomposition {
  title: string;
  summary: string;
  tasks: DecompositionTask[];
  unknowns: string[];
  risks: string[];
  firstTaskNote: string;
  /**
   * Ordered milestone roadmap when the spec defines one (ADR-009). Not edited in
   * the review UI, but carried verbatim from propose → confirm so the bootstrap
   * captures it (AGENTS.md roadmap + first-batch milestone tag). Don't drop it
   * when reconstructing the confirm payload.
   */
  milestones?: Array<{ id: string; title: string; goal: string; killGate?: string }>;
}

type Step = "compose" | "review";

const SPEC_PLACEHOLDER = `# my-project — spec

## Goal

What this project is and why it matters in one paragraph.

## Scope

- What's in
- What's deliberately out

## Tasks

1. ...
2. ...
3. ...

(Or just paste the doc you already have. We'll decompose it for you.)
`;

export function ImportSpec() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("compose");
  const [title, setTitle] = useState("");
  const [specMarkdown, setSpecMarkdown] = useState("");
  const [ceremony, setCeremony] = useState<Ceremony>("personal");
  const [role, setRole] = useState<Role>("owner");
  const [decomposition, setDecomposition] = useState<Decomposition | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const propose = useMutation({
    mutationFn: () =>
      trpc.projects.proposeImportSpec.mutate({
        title: title.trim(),
        specMarkdown,
        ceremony,
        role,
      }),
    onSuccess: (res) => {
      setDecomposition(res.decomposition);
      setStep("review");
    },
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (!decomposition) throw new Error("no decomposition to confirm");
      return trpc.projects.confirmImportSpec.mutate({
        title: title.trim(),
        specMarkdown,
        ceremony,
        role,
        model: null,
        decomposition,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      nav(`/projects/${res.projectId}`);
    },
  });

  const onPickFile = () => fileInputRef.current?.click();
  const onFile = async (file: File | null | undefined) => {
    if (!file) return;
    const text = await file.text();
    setSpecMarkdown(text);
    if (!title.trim()) {
      // Best-effort title from the filename: strip extension, replace
      // separators with spaces.
      const stem = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      setTitle(stem.slice(0, 80));
    }
  };

  if (step === "review" && decomposition) {
    return (
      <ReviewStep
        decomposition={decomposition}
        title={title}
        ceremony={ceremony}
        role={role}
        onChangeDecomposition={setDecomposition}
        onBack={() => setStep("compose")}
        onConfirm={() => confirm.mutate()}
        confirmPending={confirm.isPending}
        confirmError={confirm.isError ? (confirm.error as Error).message : null}
      />
    );
  }

  const can = specMarkdown.trim().length >= 20 && !propose.isPending;

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="surface px-4 py-3 flex items-center gap-2">
        <Link to="/" className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]">
          <ArrowLeft size={14} />
        </Link>
        <div className="display text-[16px] text-[var(--color-fg)]">import spec</div>
      </div>

      <div className="surface p-4 space-y-4">
        <div>
          <label
            htmlFor="spec-title"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            title <span className="normal-case text-[var(--color-fg-3)]">(optional)</span>
          </label>
          <input
            id="spec-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="my-project"
            className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <label
              htmlFor="spec-md"
              className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]"
            >
              spec markdown
            </label>
            <button
              type="button"
              className="chip flex items-center gap-1.5 hover:border-[var(--color-line-bright)]"
              onClick={onPickFile}
            >
              <Upload size={11} /> upload .md
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </div>
          <textarea
            id="spec-md"
            className="textarea mono text-[13px] leading-relaxed min-h-[280px]"
            placeholder={SPEC_PLACEHOLDER}
            value={specMarkdown}
            onChange={(e) => setSpecMarkdown(e.target.value)}
            spellCheck={false}
          />
          <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">
            paste or upload your fully-drafted spec — the agent decomposes it into 5–8 runnable
            tasks for your review.
          </p>
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
                  role === r ? "chip-accent" : "hover:border-[var(--color-line-bright)]",
                )}
              >
                {r}
              </button>
            ))}
          </div>
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
                  ceremony === c ? "chip-accent" : "hover:border-[var(--color-line-bright)]",
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2">
            tinker = 3–5 small tasks, light review. personal+ = 5–8 substantive tasks with tighter
            acceptance.
          </p>
        </div>

        {propose.isError ? (
          <div className="text-[12.5px] text-[var(--color-verdict-trashed)] mono">
            {(propose.error as Error).message}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={!can}
          onClick={() => propose.mutate()}
        >
          {propose.isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" /> decomposing…
            </>
          ) : (
            <>
              <Sparkles size={14} /> decompose & review
              <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>

      <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
        triage is skipped — you already know what you want. the agent reads your spec, proposes a
        task list, you approve or edit, then the project bootstraps and the first task starts.
      </p>
    </div>
  );
}

interface ReviewStepProps {
  decomposition: Decomposition;
  title: string;
  ceremony: Ceremony;
  role: Role;
  onChangeDecomposition: (d: Decomposition) => void;
  onBack: () => void;
  onConfirm: () => void;
  confirmPending: boolean;
  confirmError: string | null;
}

function ReviewStep(props: ReviewStepProps) {
  const { decomposition, onChangeDecomposition } = props;
  const update = (patch: Partial<Decomposition>) =>
    onChangeDecomposition({ ...decomposition, ...patch });
  const updateTask = (i: number, patch: Partial<DecompositionTask>) => {
    const next = decomposition.tasks.slice();
    const t = next[i];
    if (!t) return;
    next[i] = { ...t, ...patch };
    update({ tasks: next });
  };
  const removeTask = (i: number) => {
    update({ tasks: decomposition.tasks.filter((_, j) => j !== i) });
  };
  const addTask = () => {
    update({
      tasks: [...decomposition.tasks, { title: "New task", estimate: "small", acceptance: [] }],
    });
  };

  const canConfirm =
    decomposition.tasks.length > 0 &&
    decomposition.tasks.every((t) => t.title.trim().length > 0) &&
    !props.confirmPending;

  return (
    <div className="space-y-3">
      <div className="surface px-4 py-3 flex items-center gap-2">
        <button
          type="button"
          onClick={props.onBack}
          className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="display text-[16px] text-[var(--color-fg)]">review decomposition</div>
        <span className="ml-auto chip">
          {props.ceremony} · {props.role}
        </span>
      </div>

      <div className="surface p-4 space-y-4">
        <div>
          <label
            htmlFor="dec-title"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            project title
          </label>
          <input
            id="dec-title"
            type="text"
            value={decomposition.title}
            onChange={(e) => update({ title: e.target.value })}
            className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div>
          <label
            htmlFor="dec-summary"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            summary
          </label>
          <textarea
            id="dec-summary"
            className="textarea text-[13.5px] leading-relaxed min-h-[80px]"
            value={decomposition.summary}
            onChange={(e) => update({ summary: e.target.value })}
          />
        </div>

        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2 flex items-center justify-between">
            <span>tasks ({decomposition.tasks.length})</span>
            <button
              type="button"
              className="chip flex items-center gap-1.5 hover:border-[var(--color-line-bright)]"
              onClick={addTask}
            >
              <Plus size={11} /> add task
            </button>
          </div>
          <ul className="space-y-3">
            {decomposition.tasks.map((t, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: tasks are positional within decomposition
                key={i}
                className="border border-[var(--color-line)] rounded p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="mono text-[11px] text-[var(--color-fg-3)] w-12 shrink-0">
                    task-{String(i + 1).padStart(3, "0")}
                  </span>
                  <input
                    type="text"
                    value={t.title}
                    onChange={(e) => updateTask(i, { title: e.target.value })}
                    className="flex-1 bg-transparent border border-[var(--color-line)] rounded px-2 py-1 text-[13.5px] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                  <button
                    type="button"
                    onClick={() => removeTask(i)}
                    className="text-[var(--color-fg-3)] hover:text-[var(--color-verdict-trashed)] p-1"
                    aria-label="remove task"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] mr-1">est:</span>
                  {ESTIMATES.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => updateTask(i, { estimate: e })}
                      className={cn(
                        "chip text-[11px]",
                        t.estimate === e
                          ? "chip-accent"
                          : "hover:border-[var(--color-line-bright)]",
                      )}
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <div>
                  <div className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mb-1">
                    acceptance ({t.acceptance.length})
                  </div>
                  <ul className="space-y-1">
                    {t.acceptance.map((a, ai) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: acceptance criteria are positional
                        key={ai}
                        className="flex items-start gap-1.5"
                      >
                        <span className="text-[var(--color-fg-3)] mono text-[12px] mt-1">▢</span>
                        <input
                          type="text"
                          value={a}
                          onChange={(e) => {
                            const next = t.acceptance.slice();
                            next[ai] = e.target.value;
                            updateTask(i, { acceptance: next });
                          }}
                          className="flex-1 bg-transparent border-b border-[var(--color-line)] px-1 py-0.5 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateTask(i, {
                              acceptance: t.acceptance.filter((_, j) => j !== ai),
                            })
                          }
                          className="text-[var(--color-fg-3)] hover:text-[var(--color-verdict-trashed)] p-0.5"
                          aria-label="remove acceptance"
                        >
                          <Trash2 size={11} />
                        </button>
                      </li>
                    ))}
                    <li>
                      <button
                        type="button"
                        onClick={() => updateTask(i, { acceptance: [...t.acceptance, ""] })}
                        className="mono text-[11px] text-[var(--color-fg-3)] hover:text-[var(--color-accent)] flex items-center gap-1 pt-1"
                      >
                        <Plus size={10} /> add criterion
                      </button>
                    </li>
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {decomposition.unknowns.length > 0 ? (
          <CalloutList
            title="unknowns the agent flagged"
            items={decomposition.unknowns}
            onChange={(items) => update({ unknowns: items })}
          />
        ) : null}

        {decomposition.risks.length > 0 ? (
          <CalloutList
            title="risks the agent flagged"
            items={decomposition.risks}
            onChange={(items) => update({ risks: items })}
          />
        ) : null}

        {decomposition.firstTaskNote ? (
          <div>
            <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
              first-task orientation
            </div>
            <textarea
              className="textarea text-[13px] leading-relaxed min-h-[60px]"
              value={decomposition.firstTaskNote}
              onChange={(e) => update({ firstTaskNote: e.target.value })}
            />
          </div>
        ) : null}

        {props.confirmError ? (
          <div className="text-[12.5px] text-[var(--color-verdict-trashed)] mono">
            {props.confirmError}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={!canConfirm}
          onClick={props.onConfirm}
        >
          {props.confirmPending ? (
            <>
              <Loader2 size={14} className="animate-spin" /> bootstrapping…
            </>
          ) : (
            <>
              bootstrap & start <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>

      <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
        on confirm, the project is bootstrapped at{" "}
        <span className="text-[var(--color-fg-1)]">~/.factory/projects/</span>— the spec lands at
        docs/internal/SPEC.md, claude.md is seeded with a reference, and the first task starts
        immediately under auto-advance.
      </p>
    </div>
  );
}

function CalloutList(props: {
  title: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const { title, items, onChange } = props;
  return (
    <div>
      <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: callout items are positional
            key={i}
            className="flex items-start gap-1.5"
          >
            <span className="text-[var(--color-fg-3)] mono text-[12px] mt-1">·</span>
            <input
              type="text"
              value={it}
              onChange={(e) => {
                const next = items.slice();
                next[i] = e.target.value;
                onChange(next);
              }}
              className="flex-1 bg-transparent border-b border-[var(--color-line)] px-1 py-0.5 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="text-[var(--color-fg-3)] hover:text-[var(--color-verdict-trashed)] p-0.5"
              aria-label="remove"
            >
              <Trash2 size={11} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
