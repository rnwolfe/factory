import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

const ESTIMATES = ["small", "medium", "large"] as const;
type Estimate = (typeof ESTIMATES)[number];

interface MilestoneTask {
  title: string;
  estimate: Estimate;
  acceptance: string[];
}
interface Milestone {
  id: string;
  title: string;
  goal: string;
  killGate?: string;
}
interface MilestoneDecomposition {
  milestone: string;
  summary: string;
  tasks: MilestoneTask[];
  unknowns: string[];
  risks: string[];
  firstTaskNote: string;
  roadmap: Milestone[];
}

/**
 * Plan the next milestone of a spec-imported project. Re-decomposes the project's
 * committed SPEC.md scoped to one milestone (same engine as import), shows an
 * editable review, and creates the tasks into the existing project. See ADR-009.
 */
export function MilestonePlan() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [dec, setDec] = useState<MilestoneDecomposition | null>(null);

  const propose = useMutation({
    mutationFn: (milestone?: string) =>
      trpc.projects.proposeMilestone.mutate({ projectId: id, ...(milestone ? { milestone } : {}) }),
    onSuccess: (res) => setDec(res.decomposition as MilestoneDecomposition),
  });

  const confirm = useMutation({
    mutationFn: () =>
      trpc.projects.confirmMilestone.mutate({
        projectId: id,
        milestone: dec?.milestone ?? "",
        tasks: dec?.tasks ?? [],
      }),
    onSuccess: () => nav(`/projects/${id}`),
  });

  // Auto-propose the next milestone on first load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (id) propose.mutate(undefined);
  }, [id]);

  const update = (patch: Partial<MilestoneDecomposition>) =>
    setDec((d) => (d ? { ...d, ...patch } : d));
  const updateTask = (i: number, patch: Partial<MilestoneTask>) => {
    if (!dec) return;
    const next = dec.tasks.slice();
    const t = next[i];
    if (!t) return;
    next[i] = { ...t, ...patch };
    update({ tasks: next });
  };

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="surface px-4 py-3 flex items-center gap-2">
        <Link
          to={`/projects/${id}`}
          className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
          aria-label="back to project"
        >
          <ArrowLeft size={14} />
        </Link>
        <div className="display text-[16px] text-[var(--color-fg)]">plan next milestone</div>
        {dec?.milestone ? <span className="ml-auto chip">{dec.milestone}</span> : null}
      </div>

      {propose.isPending ? (
        <div className="surface p-6 flex items-center gap-2 text-[13px] text-[var(--color-fg-2)]">
          <Loader2 size={14} className="animate-spin" /> reading the spec and decomposing the next
          milestone…
        </div>
      ) : propose.isError ? (
        <div className="surface p-4 space-y-3">
          <div className="text-[13px] text-[var(--color-verdict-trashed)] mono">
            {(propose.error as Error).message}
          </div>
          <Link to={`/projects/${id}`} className="btn btn-ghost text-[12px]">
            back to project
          </Link>
        </div>
      ) : dec ? (
        <>
          {dec.roadmap.length > 0 ? (
            <div className="surface px-4 py-3">
              <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
                roadmap
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dec.roadmap.map((m) => (
                  <span
                    key={m.id}
                    title={`${m.goal}${m.killGate ? ` · kill-gate: ${m.killGate}` : ""}`}
                    className={cn("chip text-[11px]", m.id === dec.milestone ? "chip-working" : "")}
                  >
                    {m.id}
                    {m.title ? ` · ${m.title}` : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="surface p-4 space-y-4">
            <div>
              <label
                htmlFor="ms-summary"
                className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
              >
                milestone summary
              </label>
              <textarea
                id="ms-summary"
                className="textarea text-[13.5px] leading-relaxed min-h-[72px]"
                value={dec.summary}
                onChange={(e) => update({ summary: e.target.value })}
              />
            </div>

            <div>
              <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2 flex items-center justify-between">
                <span>tasks ({dec.tasks.length})</span>
                <button
                  type="button"
                  className="chip flex items-center gap-1.5 hover:border-[var(--color-line-bright)]"
                  onClick={() =>
                    update({
                      tasks: [
                        ...dec.tasks,
                        { title: "New task", estimate: "small", acceptance: [] },
                      ],
                    })
                  }
                >
                  <Plus size={11} /> add task
                </button>
              </div>
              <ul className="space-y-3">
                {dec.tasks.map((t, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: tasks are positional
                    key={i}
                    className="border border-[var(--color-line)] rounded p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="mono text-[11px] text-[var(--color-fg-3)] w-12 shrink-0">
                        {dec.milestone || "task"}·{String(i + 1).padStart(2, "0")}
                      </span>
                      <input
                        type="text"
                        value={t.title}
                        onChange={(e) => updateTask(i, { title: e.target.value })}
                        className="flex-1 bg-transparent border border-[var(--color-line)] rounded px-2 py-1 text-[13.5px] focus:outline-none focus:border-[var(--color-accent)]"
                      />
                      <button
                        type="button"
                        onClick={() => update({ tasks: dec.tasks.filter((_, j) => j !== i) })}
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
                              ? "chip-working"
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
                            <span className="text-[var(--color-fg-3)] mono text-[12px] mt-1">
                              ▢
                            </span>
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

            {dec.unknowns.length > 0 ? (
              <div>
                <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
                  unknowns the agent flagged
                </div>
                <ul className="space-y-1 text-[13px] text-[var(--color-fg-2)] list-disc list-inside">
                  {dec.unknowns.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {dec.risks.length > 0 ? (
              <div>
                <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
                  risks the agent flagged
                </div>
                <ul className="space-y-1 text-[13px] text-[var(--color-fg-2)] list-disc list-inside">
                  {dec.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {dec.firstTaskNote ? (
              <div>
                <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
                  first-task orientation
                </div>
                <textarea
                  className="textarea text-[13px] leading-relaxed min-h-[56px]"
                  value={dec.firstTaskNote}
                  onChange={(e) => update({ firstTaskNote: e.target.value })}
                />
              </div>
            ) : null}

            {confirm.isError ? (
              <div className="text-[12.5px] text-[var(--color-verdict-trashed)] mono">
                {(confirm.error as Error).message}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost text-[12px]"
                disabled={propose.isPending}
                onClick={() => propose.mutate(dec.milestone || undefined)}
                title="re-run the decomposition"
              >
                <RefreshCw size={12} /> redraft
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={
                  confirm.isPending ||
                  dec.tasks.length === 0 ||
                  !dec.tasks.every((t) => t.title.trim().length > 0)
                }
                onClick={() => confirm.mutate()}
              >
                {confirm.isPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> creating tasks…
                  </>
                ) : (
                  <>
                    create {dec.tasks.length} task{dec.tasks.length === 1 ? "" : "s"} for{" "}
                    {dec.milestone || "milestone"} <ArrowRight size={14} />
                  </>
                )}
              </button>
            </div>
          </div>

          <p className="px-2 mono text-[10.5px] text-[var(--color-fg-3)]">
            tasks are created in this project's{" "}
            <span className="text-[var(--color-fg-1)]">.factory/work/</span>, tagged with{" "}
            {dec.milestone || "the milestone"}, and start under auto-advance.
          </p>
        </>
      ) : null}
    </div>
  );
}
