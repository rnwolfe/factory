import { cn } from "../lib/cn.ts";
import { MarkdownView } from "./markdown-view.tsx";

export interface ProjectSpecDraftView {
  kind: "project_spec";
  summary: string;
  tasks: Array<{
    title: string;
    estimate: "small" | "medium" | "large";
    acceptance: string[];
  }>;
  unknowns: string[];
  risks: string[];
}

export interface TaskPlanDraftView {
  kind: "task_plan";
  goal: string;
  steps: Array<{ order: number; title: string; detail: string }>;
  acceptance: string[];
  touches: string[];
  risks: string[];
}

export interface RefinementDraftView {
  kind: "refinement";
  targetTaskId: string;
  feedback: string;
  revisedAcceptance?: string[];
  followups?: Array<{ title: string; estimate: "small" | "medium" | "large" }>;
}

export interface FeaturePlanVisionFilterTestView {
  passes: boolean;
  reasoning: string;
}

export interface FeaturePlanDraftView {
  kind: "feature_plan";
  goal: string;
  summary: string;
  tasks: Array<{
    title: string;
    estimate: "small" | "medium" | "large";
    acceptance: string[];
  }>;
  unknowns: string[];
  risks: string[];
  visionFilter: {
    identity: FeaturePlanVisionFilterTestView;
    principle: FeaturePlanVisionFilterTestView;
    phase: FeaturePlanVisionFilterTestView;
    replacement: FeaturePlanVisionFilterTestView;
  };
}

export interface ProjectVisionDraftView {
  kind: "project_vision";
  identity: string;
  audience: string;
  problem: string;
  designPrinciples: Array<{ name: string; meaning: string }>;
  outOfScope: string[];
  personality: string | null;
  roadmap: Array<{ phase: string; bullets: string[] }>;
  priorArt: string[];
}

export type AnyDraftView =
  | ProjectSpecDraftView
  | TaskPlanDraftView
  | RefinementDraftView
  | FeaturePlanDraftView
  | ProjectVisionDraftView;

interface Props {
  draft: AnyDraftView;
  /** Used to seed the per-block markdown-view storageKeys. Defaults to "anon". */
  planId?: string;
}

export function PlanDraftViewer({ draft, planId = "anon" }: Props) {
  switch (draft.kind) {
    case "project_spec":
      return <ProjectSpecView draft={draft} planId={planId} />;
    case "task_plan":
      return <TaskPlanView draft={draft} />;
    case "refinement":
      return <RefinementView draft={draft} planId={planId} />;
    case "feature_plan":
      return <FeaturePlanView draft={draft} planId={planId} />;
    case "project_vision":
      return <ProjectVisionView draft={draft} planId={planId} />;
  }
}

function FeaturePlanView({ draft, planId }: { draft: FeaturePlanDraftView; planId: string }) {
  const tests = [
    { name: "identity", value: draft.visionFilter.identity },
    { name: "principle", value: draft.visionFilter.principle },
    { name: "phase", value: draft.visionFilter.phase },
    { name: "replacement", value: draft.visionFilter.replacement },
  ];
  const allPass = tests.every((t) => t.value.passes);
  return (
    <div className="space-y-3">
      {draft.summary ? (
        <div className="px-4 py-3 surface text-[14px] leading-relaxed text-[var(--color-fg)]">
          <MarkdownView source={draft.summary} storageKey={`mdView.feature-summary.${planId}`} />
        </div>
      ) : (
        <DraftEmpty hint="no summary yet — comment to seed the feature." />
      )}

      <Section title="vision filter">
        <ul className="surface divide-y divide-[var(--color-line)]">
          {tests.map((t) => (
            <li key={t.name} className="px-4 py-2.5 flex items-start gap-2">
              <span
                className={cn(
                  "mono text-[11px] tabular-nums w-4 text-center shrink-0 mt-0.5",
                  t.value.passes
                    ? "text-[var(--color-verdict-greenlit)]"
                    : "text-[var(--color-verdict-trashed)]",
                )}
              >
                {t.value.passes ? "✓" : "✗"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-[var(--color-fg)]">{t.name}</div>
                <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                  {t.value.reasoning || "(no reasoning yet)"}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {!allPass ? (
          <div className="mt-2 mono text-[11px] text-[var(--color-fg-3)]">
            all four tests must pass to freeze on a personal+ tier project.
          </div>
        ) : null}
      </Section>

      <Section title="tasks" count={draft.tasks.length}>
        {draft.tasks.length === 0 ? (
          <DraftEmpty hint="no tasks yet." />
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.tasks.map((t, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={`${t.title}-${i}`}
                className="px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-[14px] text-[var(--color-fg)]">
                    {String(i + 1).padStart(2, "0")} · {t.title}
                  </span>
                  <span className={cn("chip", estimateTone(t.estimate))}>{t.estimate}</span>
                </div>
                {t.acceptance.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--color-fg-2)]">
                    {t.acceptance.map((line, j) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional
                        key={`${i}-${j}`}
                        className="leading-snug"
                      >
                        <span className="text-[var(--color-fg-3)]">▢</span> {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {draft.unknowns.length > 0 ? (
        <Section title="unknowns" count={draft.unknowns.length}>
          <ListBlock items={draft.unknowns} marker="?" tone="text-[var(--color-fg-2)]" />
        </Section>
      ) : null}

      {draft.risks.length > 0 ? (
        <Section title="risks" count={draft.risks.length}>
          <ListBlock items={draft.risks} marker="!" tone="text-[var(--color-verdict-trashed)]" />
        </Section>
      ) : null}
    </div>
  );
}

function ProjectVisionView({ draft }: { draft: ProjectVisionDraftView; planId: string }) {
  return (
    <div className="space-y-3">
      <div className="surface px-4 py-3">
        <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
          identity
        </div>
        <p className="text-[14px] leading-relaxed text-[var(--color-fg)]">
          {draft.identity || "(unspecified)"}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="surface px-4 py-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            audience
          </div>
          <p className="text-[13px] text-[var(--color-fg-1)]">
            {draft.audience || "(unspecified)"}
          </p>
        </div>
        <div className="surface px-4 py-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            problem
          </div>
          <p className="text-[13px] text-[var(--color-fg-1)]">{draft.problem || "(unspecified)"}</p>
        </div>
      </div>

      <Section title="design principles" count={draft.designPrinciples.length}>
        {draft.designPrinciples.length === 0 ? (
          <DraftEmpty hint="no principles yet." />
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.designPrinciples.map((p, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={`${p.name}-${i}`}
                className="px-4 py-2.5"
              >
                <div className="text-[13.5px] text-[var(--color-fg)]">{p.name}</div>
                <div className="text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
                  {p.meaning}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {draft.outOfScope.length > 0 ? (
        <Section title="out of scope" count={draft.outOfScope.length}>
          <ListBlock items={draft.outOfScope} marker="—" tone="text-[var(--color-fg-3)]" />
        </Section>
      ) : null}

      {draft.personality ? (
        <Section title="personality">
          <div className="surface px-4 py-2.5 text-[13px] leading-relaxed text-[var(--color-fg-1)]">
            {draft.personality}
          </div>
        </Section>
      ) : null}

      {draft.roadmap.length > 0 ? (
        <Section title="roadmap" count={draft.roadmap.length}>
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.roadmap.map((r, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={`${r.phase}-${i}`}
                className="px-4 py-2.5"
              >
                <div className="mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
                  {r.phase}
                </div>
                {r.bullets.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--color-fg-2)]">
                    {r.bullets.map((b, j) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional
                        key={`${i}-${j}`}
                      >
                        <span className="text-[var(--color-fg-3)]">·</span> {b}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {draft.priorArt.length > 0 ? (
        <Section title="prior art" count={draft.priorArt.length}>
          <ListBlock items={draft.priorArt} marker="↩" tone="text-[var(--color-fg-3)]" />
        </Section>
      ) : null}
    </div>
  );
}

function ProjectSpecView({ draft, planId }: { draft: ProjectSpecDraftView; planId: string }) {
  return (
    <div className="space-y-3">
      {draft.summary ? (
        <div className="px-4 py-3 surface text-[14px] leading-relaxed text-[var(--color-fg)]">
          <MarkdownView source={draft.summary} storageKey={`mdView.spec-summary.${planId}`} />
        </div>
      ) : (
        <DraftEmpty hint="no summary yet — add a comment to seed the spec." />
      )}

      <Section title="tasks" count={draft.tasks.length}>
        {draft.tasks.length === 0 ? (
          <DraftEmpty hint="no tasks yet." />
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.tasks.map((t, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: tasks are positional within draft
                key={`${t.title}-${i}`}
                className="px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-[14px] text-[var(--color-fg)]">
                    {String(i + 1).padStart(2, "0")} · {t.title}
                  </span>
                  <span className={cn("chip", estimateTone(t.estimate))}>{t.estimate}</span>
                </div>
                {t.acceptance.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--color-fg-2)]">
                    {t.acceptance.map((line, j) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: acceptance lines are positional
                        key={`${i}-${j}`}
                        className="leading-snug"
                      >
                        <span className="text-[var(--color-fg-3)]">▢</span> {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {draft.unknowns.length > 0 ? (
        <Section title="unknowns" count={draft.unknowns.length}>
          <ListBlock items={draft.unknowns} marker="?" tone="text-[var(--color-fg-2)]" />
        </Section>
      ) : null}

      {draft.risks.length > 0 ? (
        <Section title="risks" count={draft.risks.length}>
          <ListBlock items={draft.risks} marker="!" tone="text-[var(--color-verdict-trashed)]" />
        </Section>
      ) : null}
    </div>
  );
}

function TaskPlanView({ draft }: { draft: TaskPlanDraftView }) {
  return (
    <div className="space-y-3">
      {draft.goal ? (
        <p className="px-4 py-3 surface text-[14px] leading-relaxed text-[var(--color-fg)]">
          {draft.goal}
        </p>
      ) : (
        <DraftEmpty hint="no plan yet — comment to ask the agent for a draft." />
      )}

      <Section title="steps" count={draft.steps.length}>
        {draft.steps.length === 0 ? (
          <DraftEmpty hint="no steps yet." />
        ) : (
          <ol className="surface divide-y divide-[var(--color-line)]">
            {draft.steps.map((s) => (
              <li key={`${s.order}-${s.title}`} className="px-4 py-3">
                <div className="text-[14px] text-[var(--color-fg)]">
                  {String(s.order).padStart(2, "0")} · {s.title}
                </div>
                {s.detail ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-fg-2)]">
                    {s.detail}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {draft.acceptance.length > 0 ? (
        <Section title="acceptance" count={draft.acceptance.length}>
          <ListBlock items={draft.acceptance} marker="▢" tone="text-[var(--color-fg-1)]" />
        </Section>
      ) : null}

      {draft.touches.length > 0 ? (
        <Section title="touches" count={draft.touches.length}>
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.touches.map((t) => (
              <li key={t} className="px-4 py-2 mono text-[12px] text-[var(--color-fg-1)] truncate">
                {t}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {draft.risks.length > 0 ? (
        <Section title="risks" count={draft.risks.length}>
          <ListBlock items={draft.risks} marker="!" tone="text-[var(--color-verdict-trashed)]" />
        </Section>
      ) : null}
    </div>
  );
}

function RefinementView({ draft, planId }: { draft: RefinementDraftView; planId: string }) {
  return (
    <div className="space-y-3">
      <div className="px-4 py-3 surface">
        <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1.5">
          target
        </div>
        <div className="mono text-[12px] text-[var(--color-fg-1)]">{draft.targetTaskId}</div>
      </div>
      {draft.feedback ? (
        <Section title="agent's restatement of feedback">
          <div className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg)]">
            <MarkdownView
              source={draft.feedback}
              storageKey={`mdView.refinement-feedback.${planId}`}
            />
          </div>
        </Section>
      ) : (
        <DraftEmpty hint="no feedback summary yet — comment with what changed." />
      )}

      {draft.revisedAcceptance && draft.revisedAcceptance.length > 0 ? (
        <Section title="revised acceptance" count={draft.revisedAcceptance.length}>
          <ListBlock items={draft.revisedAcceptance} marker="▢" tone="text-[var(--color-fg-1)]" />
        </Section>
      ) : null}

      {draft.followups && draft.followups.length > 0 ? (
        <Section title="follow-ups" count={draft.followups.length}>
          <ul className="surface divide-y divide-[var(--color-line)]">
            {draft.followups.map((f, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: followups are positional within draft
                key={`${f.title}-${i}`}
                className="px-4 py-3 flex items-baseline justify-between gap-3"
              >
                <span className="text-[14px] text-[var(--color-fg)]">{f.title}</span>
                <span className={cn("chip", estimateTone(f.estimate))}>{f.estimate}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          {title}
        </span>
        <div className="hairline flex-1" />
        {typeof count === "number" ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{count}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function ListBlock({ items, marker, tone }: { items: string[]; marker: string; tone: string }) {
  return (
    <ul className="surface divide-y divide-[var(--color-line)]">
      {items.map((line, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: list lines are positional within draft
          key={`${marker}-${i}`}
          className="px-4 py-2 text-[13px] leading-relaxed text-[var(--color-fg-1)] flex gap-2"
        >
          <span className={cn("shrink-0", tone)}>{marker}</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function DraftEmpty({ hint }: { hint: string }) {
  return <div className="surface px-4 py-3 text-[12.5px] text-[var(--color-fg-3)]">{hint}</div>;
}

function estimateTone(estimate: "small" | "medium" | "large"): string {
  switch (estimate) {
    case "small":
      return "chip-greenlit";
    case "medium":
      return "";
    case "large":
      return "chip-trashed";
  }
}
