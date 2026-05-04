import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCheck, Loader2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type Tier, TierPicker } from "../components/tier-picker.tsx";
import { trpc } from "../lib/trpc.ts";

const SHIPPED_TEMPLATES: Array<{
  name: string;
  kind: "read-only" | "exec";
  description: string;
  recommendedFor: Tier[];
}> = [
  {
    name: "docs-audit",
    kind: "read-only",
    description: "VISION/CLAUDE/README coherence; outdated references.",
    recommendedFor: ["personal", "share", "productize"],
  },
  {
    name: "task-sweep",
    kind: "read-only",
    description: "Score open tasks against a quality checklist.",
    recommendedFor: ["personal", "share", "productize"],
  },
  {
    name: "drift-check",
    kind: "read-only",
    description: "Compare last run's actual touches vs declared task_plan.touches.",
    recommendedFor: ["personal", "share", "productize"],
  },
  {
    name: "code-review",
    kind: "exec",
    description: "Read recent diffs; surface logic / security / convention findings.",
    recommendedFor: ["share", "productize"],
  },
];

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
      trpc.audits.listSkills.query({ projectId: id }) as unknown as Promise<
        { name: string; kind: "read-only" | "exec" }[]
      >,
    enabled: id.length > 0,
  });

  const startVision = useMutation({
    mutationFn: () => trpc.plans.startProjectVision.mutate({ projectId: id }),
    onSuccess: (data) => {
      nav(`/plans/${data.planId}`);
    },
  });

  const installedNames = new Set(installed.data?.map((s) => s.name) ?? []);
  const tier = (project.data?.project?.tier ?? "tinker") as Tier;
  const visionPresent = false; // we don't have a query for VISION.md presence
  // ^ We can detect presence by checking the workdir tree, but for simplicity
  //   the start-vision button is always visible — the daemon's
  //   startProjectVision is idempotent for drafting plans, so re-clicking
  //   navigates to the existing draft.
  void visionPresent;

  // For now, "install template" is a manual operator step — Factory ships
  // templates under `docs/audit-skill-templates/` and the operator copies the
  // ones they want into `<project>/.factory/audits/<name>/`. v0.4 will add a
  // one-click install action. The deepening flow surfaces the recommended
  // set so the operator knows what to copy.

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
            <TierPicker
              projectId={id}
              tier={tier}
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
            disabled={startVision.isPending || tier === "tinker"}
            onClick={() => startVision.mutate()}
          >
            {startVision.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> starting…
              </>
            ) : tier === "tinker" ? (
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
            Factory ships templates under{" "}
            <span className="mono text-[12px]">docs/audit-skill-templates/</span>. Copy the ones
            recommended for your tier into{" "}
            <span className="mono text-[12px]">
              &lt;project&gt;/.factory/audits/&lt;name&gt;/SKILL.md
            </span>{" "}
            to enable them. (v0.4 will automate this with a one-click install.)
          </p>
          <ul className="divide-y divide-[var(--color-line)] surface">
            {SHIPPED_TEMPLATES.map((t) => {
              const recommended = t.recommendedFor.includes(tier);
              const isInstalled = installedNames.has(t.name);
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
                      <span className="chip">{t.kind}</span>
                      {recommended ? <span className="chip chip-accent">recommended</span> : null}
                      {isInstalled ? <span className="chip chip-greenlit">installed</span> : null}
                    </div>
                    <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                      {t.description}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
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
