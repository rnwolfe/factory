import { cn } from "../lib/cn.ts";

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

export type AnyDraftView = ProjectSpecDraftView | TaskPlanDraftView | RefinementDraftView;

interface Props {
  draft: AnyDraftView;
}

export function PlanDraftViewer({ draft }: Props) {
  switch (draft.kind) {
    case "project_spec":
      return <ProjectSpecView draft={draft} />;
    case "task_plan":
      return <TaskPlanView draft={draft} />;
    case "refinement":
      return <RefinementView draft={draft} />;
  }
}

function ProjectSpecView({ draft }: { draft: ProjectSpecDraftView }) {
  return (
    <div className="space-y-3">
      {draft.summary ? (
        <p className="px-4 py-3 surface text-[14px] leading-relaxed text-[var(--color-fg)]">
          {draft.summary}
        </p>
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

function RefinementView({ draft }: { draft: RefinementDraftView }) {
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
          <p className="px-4 py-3 text-[14px] leading-relaxed text-[var(--color-fg)]">
            {draft.feedback}
          </p>
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
