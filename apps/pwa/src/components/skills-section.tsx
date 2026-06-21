import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

/**
 * A project-local skill discovered at `<project>/.claude/skills/<name>/SKILL.md`.
 * Mirrors the `ProjectSkill` shape returned by the `skills.list` tRPC query.
 */
interface ProjectSkill {
  name: string;
  description: string;
  filePath: string;
}

interface Props {
  projectId: string;
}

/**
 * Lists the project's repo-canonical `.claude/skills/` skills and lets the
 * operator launch a harness-agnostic run for each (`skills.submit`). Modeled on
 * `audits-section.tsx`: dense rows, a per-row run button that reflects pending
 * state, and an explicit empty state. A successful submit navigates to the run.
 */
export function SkillsSection({ projectId }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const skills = useQuery({
    queryKey: ["skills.list", projectId],
    queryFn: () => trpc.skills.list.query({ projectId }) as unknown as Promise<ProjectSkill[]>,
    enabled: projectId.length > 0,
  });

  const submit = useMutation({
    mutationFn: (skillName: string) => trpc.skills.submit.mutate({ projectId, skillName }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["runs.list", projectId] });
      nav(`/projects/${projectId}/runs/${data.runId}`);
    },
  });

  const skillRows = skills.data ?? [];

  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          skills
        </span>
        <div className="hairline flex-1" />
        {skillRows.length > 0 ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {skillRows.length} skill{skillRows.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {skillRows.length > 0 ? (
        <div className="surface divide-y divide-[var(--color-line)]">
          {skillRows.map((s) => (
            <div key={s.name} className="flex items-stretch">
              <div className="flex-1 min-w-0 px-3 py-2.5">
                <div className="text-[14px] truncate">{s.name}</div>
                <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                  {s.description || "no description"}
                </div>
              </div>
              <div className="flex items-center px-2 border-l border-[var(--color-line)]">
                <button
                  type="button"
                  onClick={() => submit.mutate(s.name)}
                  disabled={submit.isPending}
                  className="btn btn-ghost text-[11px] !h-8 !px-2"
                  aria-label={`run ${s.name}`}
                >
                  {submit.isPending && submit.variables === s.name ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Play size={12} />
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="surface px-3 py-3 text-[13px] text-[var(--color-fg-3)]">
          no skills in this project — add one at{" "}
          <span className="mono text-[11px]">.claude/skills/&lt;name&gt;/SKILL.md</span>.
        </div>
      )}

      {submit.isError ? (
        <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(submit.error as Error).message}
        </div>
      ) : null}
    </section>
  );
}
