import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileText } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

const CEREMONIES = ["tinker", "personal", "shared", "production"] as const;
const ROLES = ["owner", "contributor"] as const;
type Ceremony = (typeof CEREMONIES)[number] | "";
type Role = (typeof ROLES)[number] | "";

export function NewIdea() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [ceremony, setCeremony] = useState<Ceremony>("");
  const [role, setRole] = useState<Role>("");

  const submit = useMutation({
    mutationFn: (vars: { rawText: string; intentCeremony?: Ceremony; intentRole?: Role }) =>
      trpc.ideas.create.mutate({
        rawText: vars.rawText,
        intentCeremony:
          vars.intentCeremony && vars.intentCeremony.length > 0
            ? (vars.intentCeremony as Exclude<Ceremony, "">)
            : undefined,
        intentRole:
          vars.intentRole && vars.intentRole.length > 0
            ? (vars.intentRole as Exclude<Role, "">)
            : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["ideas.list"] });
      nav("/");
    },
  });

  const can = text.trim().length > 0 && !submit.isPending;

  return (
    <div className="space-y-3">
      <Link
        to="/inbox/import-spec"
        className="surface px-4 py-3 flex items-center gap-3 active:bg-[var(--color-bg-2)] hover:border-[var(--color-line-bright)]"
      >
        <FileText size={16} className="text-[var(--color-accent)] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="display text-[14px] text-[var(--color-fg)] leading-tight">
            already have a spec?
          </div>
          <div className="mono text-[10.5px] text-[var(--color-fg-3)] mt-0.5">
            skip triage — upload the doc, agent decomposes it, project bootstraps
          </div>
        </div>
        <ArrowRight size={14} className="text-[var(--color-fg-3)] shrink-0" />
      </Link>

      <div className="surface p-4">
        <label
          htmlFor="idea-text"
          className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2"
        >
          idea
        </label>
        <textarea
          id="idea-text"
          // biome-ignore lint/a11y/noAutofocus: single-purpose capture screen
          autoFocus
          className="textarea"
          placeholder="what's on your mind? a sentence is enough."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="mt-4 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          role (optional)
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(role === r ? "" : r)}
              className={
                role === r ? "chip chip-accent" : "chip hover:border-[var(--color-line-bright)]"
              }
            >
              {r}
            </button>
          ))}
        </div>

        <div className="mt-4 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          ceremony (optional)
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CEREMONIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCeremony(ceremony === c ? "" : c)}
              className={
                ceremony === c ? "chip chip-accent" : "chip hover:border-[var(--color-line-bright)]"
              }
            >
              {c}
            </button>
          ))}
        </div>

        {submit.isError ? (
          <div className="mt-3 text-xs text-[var(--color-verdict-trashed)]">
            {(submit.error as Error).message}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary w-full mt-5"
          disabled={!can}
          onClick={() =>
            submit.mutate({
              rawText: text,
              intentCeremony: ceremony,
              intentRole: role,
            })
          }
        >
          {submit.isPending ? "submitting…" : "submit & triage"}
          {!submit.isPending && <ArrowRight size={16} />}
        </button>
      </div>

      <p className="text-[12px] mono text-[var(--color-fg-3)] px-2">
        Heimdall will triage this against the active rubric within ~2 min and surface a decision
        card.
      </p>
    </div>
  );
}
