import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";

interface Props {
  projectId: string;
  onClose: () => void;
}

type Kind = "bug" | "feature" | "refactor" | "docs" | "other";
type Priority = "low" | "med" | "high";

const KINDS: ReadonlyArray<Kind> = ["bug", "feature", "refactor", "docs", "other"];
const PRIORITIES: ReadonlyArray<Priority> = ["low", "med", "high"];

/**
 * Ad-hoc task capture — the fast path for "report a bug" or "build this
 * feature" requests on a specific project. Bypasses the idea → triage →
 * plan pipeline (correct when the operator already knows they want it).
 *
 * Optional "run now" toggle creates the task and immediately submits a
 * run for it, so a one-shot bug report can complete without a second
 * click. With it off, the task lands as ready and the operator picks
 * the moment to run.
 */
export function NewTaskModal({ projectId, onClose }: Props) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind>("feature");
  const [priority, setPriority] = useState<Priority>("med");
  const [body, setBody] = useState("");
  const [runNow, setRunNow] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();

  const create = useMutation({
    mutationFn: async () => {
      const created = await trpc.projects.tasks.create.mutate({
        projectId,
        title: title.trim(),
        labels: [kind],
        priority,
        body: body.trim() || undefined,
      });
      const taskId = created.task.frontmatter.id;
      if (runNow) {
        const run = (await trpc.runs.start.mutate({
          projectId,
          taskId,
        })) as { runId: string };
        return { taskId, runId: run.runId };
      }
      return { taskId, runId: null };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["runs.list", projectId] });
      if (res.runId) {
        nav(`/projects/${projectId}/runs/${res.runId}`);
      } else {
        onClose();
      }
    },
  });

  const canSubmit = title.trim().length > 0 && !create.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
    >
      <div className="surface w-full max-w-md max-h-[90vh] overflow-y-auto p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Plus size={16} />
            <span className="display text-lg">new task</span>
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label
              htmlFor="new-task-title"
              className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] block mb-1"
            >
              title
            </label>
            <input
              id="new-task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. fix the paste handler in the recipe editor"
              className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)]"
              disabled={create.isPending}
              ref={(el) => {
                if (el) el.focus();
              }}
            />
          </div>

          <div className="flex gap-3 flex-wrap">
            <div>
              <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] block mb-1">
                kind
              </span>
              <div className="flex flex-wrap gap-1">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn("chip", kind === k ? "chip-accent" : "")}
                    disabled={create.isPending}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] block mb-1">
                priority
              </span>
              <div className="flex gap-1">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn("chip", priority === p ? "chip-accent" : "")}
                    disabled={create.isPending}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label
              htmlFor="new-task-body"
              className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] block mb-1"
            >
              body <span className="normal-case text-[var(--color-fg-3)]">(optional)</span>
            </label>
            <textarea
              id="new-task-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="add context, repro steps, acceptance criteria, links. agent will work from this + the title."
              className="w-full bg-transparent border border-[var(--color-line)] rounded px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-accent)] resize-y"
              disabled={create.isPending}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={runNow}
              onChange={(e) => setRunNow(e.target.checked)}
              disabled={create.isPending}
              className="accent-[var(--color-accent)]"
            />
            <span className="text-[13px] text-[var(--color-fg-1)]">
              run immediately after creating
            </span>
          </label>

          {create.isError ? (
            <p className="mono text-[11px] text-[var(--color-verdict-trashed)]">
              {(create.error as Error).message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost text-[12px]"
              disabled={create.isPending}
            >
              cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {create.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  {runNow ? "creating + starting…" : "creating…"}
                </>
              ) : runNow ? (
                "create + run"
              ) : (
                "create task"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
