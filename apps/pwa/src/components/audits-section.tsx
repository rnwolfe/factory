import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Play } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";
import type { AuditRow } from "./audit-card.tsx";

interface SkillFrontmatter {
  name: string;
  description: string;
  kind: "read-only" | "exec";
  needsWorktree: boolean;
  defaultSeverityGrade: "enabled" | "disabled";
}

interface TemplateSummary {
  name: string;
  frontmatter: SkillFrontmatter;
}

interface Props {
  projectId: string;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AuditsSection({ projectId }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const skills = useQuery({
    queryKey: ["audits.listSkills", projectId],
    queryFn: () =>
      trpc.audits.listSkills.query({ projectId }) as unknown as Promise<SkillFrontmatter[]>,
    enabled: projectId.length > 0,
  });

  const templates = useQuery({
    queryKey: ["audits.listTemplates"],
    queryFn: () => trpc.audits.listTemplates.query() as unknown as Promise<TemplateSummary[]>,
  });

  const audits = useQuery({
    queryKey: ["audits.list", projectId],
    queryFn: () => trpc.audits.list.query({ projectId }) as unknown as Promise<AuditRow[]>,
    enabled: projectId.length > 0,
    refetchInterval: 8_000,
  });

  const submit = useMutation({
    mutationFn: (skillName: string) => trpc.audits.submit.mutate({ projectId, skillName }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["audits.list", projectId] });
      nav(`/projects/${projectId}/audits/${data.auditId}`);
    },
  });

  const install = useMutation({
    mutationFn: (templateName: string) =>
      trpc.audits.installTemplate.mutate({ projectId, templateName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["audits.listSkills", projectId] });
    },
  });

  const skillRows = skills.data ?? [];
  const templateRows = templates.data ?? [];
  const auditRows = audits.data ?? [];
  const recentAudits = auditRows.filter((a) => a.status !== "approved" && a.status !== "rejected");
  const approvedAudits = auditRows.filter((a) => a.status === "approved");
  const installedNames = new Set(skillRows.map((s) => s.name));
  const availableTemplates = templateRows.filter((t) => !installedNames.has(t.name));

  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          audits
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
                  {s.kind} · {s.description.slice(0, 80)}
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
                  {submit.isPending ? (
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
          no audit skills installed yet — install one below to get started.
        </div>
      )}

      {submit.isError ? (
        <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(submit.error as Error).message}
        </div>
      ) : null}

      {availableTemplates.length > 0 ? (
        <details className="mt-3" open={skillRows.length === 0}>
          <summary className="cursor-pointer mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]">
            available templates ({availableTemplates.length})
          </summary>
          <div className="surface divide-y divide-[var(--color-line)] mt-2">
            {availableTemplates.map((t) => (
              <div key={t.name} className="flex items-stretch">
                <div className="flex-1 min-w-0 px-3 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] truncate">{t.name}</span>
                    <span className="chip">{t.frontmatter.kind}</span>
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {t.frontmatter.description.slice(0, 100)}
                  </div>
                </div>
                <div className="flex items-center px-2 border-l border-[var(--color-line)]">
                  <button
                    type="button"
                    onClick={() => install.mutate(t.name)}
                    disabled={install.isPending}
                    className="btn btn-ghost text-[11px] !h-8 !px-2"
                    aria-label={`install ${t.name}`}
                  >
                    {install.isPending && install.variables === t.name ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {install.isError ? (
            <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
              {(install.error as Error).message}
            </div>
          ) : null}
        </details>
      ) : null}

      {recentAudits.length > 0 ? (
        <div className="mt-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
            recent
          </div>
          <ul className="surface divide-y divide-[var(--color-line)]">
            {recentAudits.slice(0, 8).map((a) => (
              <li key={a.id}>
                <Link
                  to={`/projects/${projectId}/audits/${a.id}`}
                  className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="chip">{a.status}</span>
                    <span className="text-[13px] truncate flex-1">{a.skillName}</span>
                    <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                      {timeAgo(a.completedAt ?? a.startedAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {approvedAudits.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            approved reports ({approvedAudits.length})
          </summary>
          <ul className="surface divide-y divide-[var(--color-line)] mt-2">
            {approvedAudits.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/projects/${projectId}/audits/${a.id}`}
                  className="block px-3 py-2 hover:bg-[var(--color-bg-2)]"
                >
                  <div className="text-[13px] truncate">{a.skillName}</div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {a.approvedReportPath ?? "(committed)"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
