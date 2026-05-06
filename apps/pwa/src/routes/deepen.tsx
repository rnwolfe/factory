import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCheck, Download, Loader2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type Ceremony, CeremonyPicker } from "../components/ceremony-picker.tsx";
import { trpc } from "../lib/trpc.ts";

interface TemplateSummary {
  name: string;
  frontmatter: {
    name: string;
    description: string;
    kind: "read-only" | "exec";
    needsWorktree: boolean;
    defaultSeverityGrade: "enabled" | "disabled";
  };
}

interface InstalledSkill {
  name: string;
  description: string;
  kind: "read-only" | "exec";
}

/**
 * Ceremony-based recommendations are UI advice, not template metadata —
 * they indicate which shipped templates a project at a given ceremony
 * benefits most from. Templates not listed here aren't recommended for
 * any ceremony and only show up under "other available."
 */
const RECOMMENDED_FOR: Record<string, Ceremony[]> = {
  "docs-audit": ["personal", "shared", "production"],
  "task-sweep": ["personal", "shared", "production"],
  "drift-check": ["personal", "shared", "production"],
  "code-review": ["shared", "production"],
};

export function Deepen() {
  const { id = "" } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: ["projects.get", id],
    queryFn: () => trpc.projects.get.query({ id }),
    enabled: id.length > 0,
  });

  const installed = useQuery({
    queryKey: ["audits.listSkills", id],
    queryFn: () =>
      trpc.audits.listSkills.query({ projectId: id }) as unknown as Promise<InstalledSkill[]>,
    enabled: id.length > 0,
  });

  const templates = useQuery({
    queryKey: ["audits.listTemplates"],
    queryFn: () => trpc.audits.listTemplates.query() as unknown as Promise<TemplateSummary[]>,
  });

  const startVision = useMutation({
    mutationFn: () => trpc.plans.startProjectVision.mutate({ projectId: id }),
    onSuccess: (data) => {
      nav(`/plans/${data.planId}`);
    },
  });

  const install = useMutation({
    mutationFn: (templateName: string) =>
      trpc.audits.installTemplate.mutate({ projectId: id, templateName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["audits.listSkills", id] });
    },
  });

  const installedNames = new Set(installed.data?.map((s) => s.name) ?? []);
  const ceremony = (project.data?.project?.ceremony ?? "tinker") as Ceremony;
  const tmplRows = templates.data ?? [];

  return (
    <div className="space-y-3 pb-4">
      <header className="surface p-4">
        <Link
          to={`/projects/${id}`}
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> project
        </Link>
        <h1 className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2">
          /deepen — {project.data?.project?.name ?? "…"}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg-2)]">
          A guided walkthrough that brings a project up to its tier's expected ceremony. Each step
          is independent — exit and return whenever.
        </p>
      </header>

      <section>
        <SectionHeader title="1 · tier" />
        <div className="surface p-4 flex items-center gap-3 flex-wrap">
          <span className="text-[14px]">project tier is</span>
          {project.data ? (
            <CeremonyPicker
              projectId={id}
              ceremony={ceremony}
              onChanged={() => qc.invalidateQueries({ queryKey: ["projects.get", id] })}
            />
          ) : null}
          <span className="text-[12.5px] text-[var(--color-fg-3)]">
            tinker projects skip ceremony; personal+ get vision and lightweight audits.
          </span>
        </div>
      </section>

      <section>
        <SectionHeader title="2 · vision" />
        <div className="surface p-4 space-y-2">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
            VISION.md is the project's identity document. Authoring it now grounds future feature
            plans and audits.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={startVision.isPending || ceremony === "tinker"}
            onClick={() => startVision.mutate()}
          >
            {startVision.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> starting…
              </>
            ) : ceremony === "tinker" ? (
              "vision not required for tinker"
            ) : (
              "start project_vision plan"
            )}
          </button>
        </div>
      </section>

      <section>
        <SectionHeader title="3 · audit skills" />
        <div className="surface p-4 space-y-2">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
            Click install to copy a template into{" "}
            <span className="mono text-[12px]">
              &lt;project&gt;/.factory/audits/&lt;name&gt;/SKILL.md
            </span>{" "}
            and commit it. Customize the file in the project repo afterward.
          </p>
          <ul className="divide-y divide-[var(--color-line)] surface">
            {tmplRows.map((t) => {
              const recommended = (RECOMMENDED_FOR[t.name] ?? []).includes(ceremony);
              const isInstalled = installedNames.has(t.name);
              const isPending = install.isPending && install.variables === t.name;
              return (
                <li key={t.name} className="px-3 py-2.5 flex items-start gap-3">
                  <span
                    className={`mono text-[10.5px] tabular-nums w-4 text-center mt-0.5 ${
                      isInstalled
                        ? "text-[var(--color-verdict-greenlit)]"
                        : recommended
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-fg-3)]"
                    }`}
                  >
                    {isInstalled ? "✓" : recommended ? "·" : ""}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13.5px] text-[var(--color-fg)]">{t.name}</span>
                      <span className="chip">{t.frontmatter.kind}</span>
                      {recommended ? <span className="chip chip-accent">recommended</span> : null}
                      {isInstalled ? <span className="chip chip-greenlit">installed</span> : null}
                    </div>
                    <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                      {t.frontmatter.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px] !h-8 !px-2"
                    disabled={isInstalled || isPending}
                    onClick={() => install.mutate(t.name)}
                    aria-label={`install ${t.name}`}
                  >
                    {isPending ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <>
                        <Download size={12} /> install
                      </>
                    )}
                  </button>
                </li>
              );
            })}
            {tmplRows.length === 0 && !templates.isLoading ? (
              <li className="px-3 py-2.5 text-[12.5px] text-[var(--color-fg-3)]">
                no audit skill templates available.
              </li>
            ) : null}
          </ul>
          {install.isError ? (
            <div className="mono text-[11px] text-[var(--color-verdict-trashed)]">
              {(install.error as Error).message}
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <SectionHeader title="4 · all set" />
        <div className="surface p-4 space-y-2">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
            Steps 1-3 are independently completable. When you're done, return to the project page.
          </p>
          <Link to={`/projects/${id}`} className="btn btn-ghost">
            <CheckCheck size={14} /> back to project
          </Link>
        </div>
      </section>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
    </div>
  );
}
