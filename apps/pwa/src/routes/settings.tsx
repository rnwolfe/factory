import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

interface SettingsSnapshot {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  githubToken: { has: boolean };
  factoryProjectId: string | null;
  overridden: Record<string, boolean>;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}

export function Settings() {
  const { token, clear } = useAuth();
  const ping = useQuery({
    queryKey: ["health.ping"],
    queryFn: () => trpc.health.ping.query(),
    refetchInterval: 5_000,
  });
  const settings = useQuery({
    queryKey: ["settings.get"],
    queryFn: () => trpc.settings.get.query() as unknown as Promise<SettingsSnapshot>,
  });
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query() as unknown as Promise<ProjectRow[]>,
  });
  const rubrics = useQuery({
    queryKey: ["rubrics.list"],
    queryFn: () => trpc.rubrics.list.query(),
  });

  return (
    <div className="space-y-4">
      <Section title="connection">
        <Row label="server">
          <span className="mono text-[12px]">{location.host}</span>
        </Row>
        <Row label="status">
          {ping.isError ? (
            <span className="chip chip-trashed">offline</span>
          ) : ping.data ? (
            <span className="chip chip-greenlit">online</span>
          ) : (
            <span className="chip">probing…</span>
          )}
        </Row>
      </Section>

      <Section title="auth">
        <Row label="bearer token">
          <span className="mono text-[12px] text-[var(--color-fg-2)]">
            {token ? `…${token.slice(-6)}` : "—"}
          </span>
        </Row>
        <div className="px-3 pb-3 pt-2">
          <button type="button" className="btn btn-danger w-full" onClick={clear}>
            forget token
          </button>
          <p className="mt-2 text-[10.5px] mono text-[var(--color-fg-3)] leading-relaxed">
            bearer token lives in{" "}
            <span className="text-[var(--color-fg-2)]">~/.factory/config.yaml</span> — rotate via
            the daemon, then forget + re-paste here.
          </p>
        </div>
      </Section>

      <Section title="operator settings">
        {settings.isLoading || !settings.data ? (
          <div className="px-3 py-3">
            <div className="skel h-3 w-2/3 mb-1.5" />
            <div className="skel h-3 w-1/2" />
          </div>
        ) : (
          <>
            <EditableRow
              label="git author name"
              value={settings.data.gitAuthor.name}
              settingKey="git-author-name"
              overridden={settings.data.overridden["git-author-name"] ?? false}
            />
            <EditableRow
              label="git author email"
              value={settings.data.gitAuthor.email}
              settingKey="git-author-email"
              overridden={settings.data.overridden["git-author-email"] ?? false}
            />
            <EditableRow
              label="max concurrent runs"
              value={String(settings.data.maxConcurrentRuns)}
              settingKey="max-concurrent-runs"
              overridden={settings.data.overridden["max-concurrent-runs"] ?? false}
              hint="takes effect on next daemon restart"
              type="number"
            />
            <RunBudgetRow
              seconds={settings.data.defaultRunBudgetSeconds}
              overridden={settings.data.overridden["default-run-budget-seconds"] ?? false}
            />
            <GithubTokenRow has={settings.data.githubToken.has} />
            <FactoryProjectRow
              currentId={settings.data.factoryProjectId}
              overridden={settings.data.overridden["factory-project-id"] ?? false}
              projects={projects.data ?? []}
            />
          </>
        )}
      </Section>

      <Section title="agent">
        <Link
          to="/settings/prompts"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">prompts</span>
          <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
        </Link>
        <Link
          to="/settings/rubrics"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">rubrics</span>
          <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
        </Link>
        <Link
          to="/metrics"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">runtime metrics</span>
          <MetricsTotalChip />
        </Link>
      </Section>

      <Section title="storage">
        <Link
          to="/settings/worktrees"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">worktrees</span>
          <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
        </Link>
      </Section>

      <Section title="active rubric">
        {rubrics.data && rubrics.data.length > 0 ? (
          rubrics.data.map((r) => (
            <Row key={r.id} label={r.rubricKey}>
              <span className="mono text-[12px] text-[var(--color-fg-2)]">v{r.version}</span>
            </Row>
          ))
        ) : (
          <Row label="status">
            <span className="mono text-[12px] text-[var(--color-fg-3)]">no active rubric</span>
          </Row>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface">
      <div className="px-3 py-2 border-b border-[var(--color-line)] mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0">
      <span className="text-[13px] text-[var(--color-fg-1)]">{label}</span>
      {children}
    </div>
  );
}

function EditableRow({
  label,
  value,
  settingKey,
  overridden,
  hint,
  type,
}: {
  label: string;
  value: string;
  settingKey: string;
  overridden: boolean;
  hint?: string;
  type?: "text" | "number";
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const save = useMutation({
    mutationFn: (next: string) =>
      trpc.settings.set.mutate({ key: settingKey as never, value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      qc.invalidateQueries({ queryKey: ["projects.hasGithubToken"] });
      setEditing(false);
    },
  });

  const clearOverride = useMutation({
    mutationFn: () => trpc.settings.clear.mutate({ key: settingKey as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      setEditing(false);
    },
  });

  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-[var(--color-fg-1)] truncate">{label}</span>
          {overridden ? (
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">db</span>
          ) : (
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">yaml</span>
          )}
        </div>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              type={type ?? "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1 w-[160px]"
            />
            <button
              type="button"
              onClick={() => save.mutate(draft)}
              disabled={save.isPending || draft === value}
              aria-label="save"
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              {save.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Check size={12} />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
              aria-label="cancel"
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="mono text-[12px] text-[var(--color-fg-2)] tabular-nums">{value}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`edit ${label}`}
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              <Pencil size={11} />
            </button>
          </div>
        )}
      </div>
      {save.isError ? (
        <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
          {(save.error as Error).message}
        </div>
      ) : null}
      {hint ? <div className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)]">{hint}</div> : null}
      {overridden && !editing ? (
        <button
          type="button"
          onClick={() => clearOverride.mutate()}
          disabled={clearOverride.isPending}
          className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)] underline hover:text-[var(--color-fg-1)]"
        >
          revert to yaml default
        </button>
      ) : null}
    </div>
  );
}

/**
 * Default-run-budget row. 0 = infinite (matches running `claude` directly,
 * where there's no wall-clock cap). Shows a chip toggle alongside the
 * number editor: when "infinite" is on, the number is locked to 0 and
 * displayed as ∞ in the read-only state.
 */
function RunBudgetRow({ seconds, overridden }: { seconds: number; overridden: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(seconds));
  const [infinite, setInfinite] = useState(seconds === 0);

  useEffect(() => {
    setDraft(String(seconds));
    setInfinite(seconds === 0);
  }, [seconds]);

  const save = useMutation({
    mutationFn: (next: string) =>
      trpc.settings.set.mutate({ key: "default-run-budget-seconds" as never, value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      setEditing(false);
    },
  });

  const clearOverride = useMutation({
    mutationFn: () => trpc.settings.clear.mutate({ key: "default-run-budget-seconds" as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      setEditing(false);
    },
  });

  const display = seconds === 0 ? "infinite" : `${seconds}s`;
  const nextValue = infinite ? "0" : draft;
  const dirty = nextValue !== String(seconds);

  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-[var(--color-fg-1)] truncate">default run budget</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {overridden ? "db" : "yaml"}
          </span>
        </div>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setInfinite((v) => !v)}
              aria-pressed={infinite}
              className={`mono text-[11px] !h-7 !px-2 rounded border ${
                infinite
                  ? "bg-[var(--color-accent)] text-[var(--color-bg)] border-[var(--color-accent)]"
                  : "bg-[var(--color-bg-2)] border-[var(--color-line)] text-[var(--color-fg-2)]"
              }`}
            >
              ∞
            </button>
            <input
              type="number"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={infinite}
              className="mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1 w-[120px] disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => save.mutate(nextValue)}
              disabled={save.isPending || !dirty}
              aria-label="save"
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              {save.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Check size={12} />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(String(seconds));
                setInfinite(seconds === 0);
                setEditing(false);
              }}
              aria-label="cancel"
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="mono text-[12px] text-[var(--color-fg-2)] tabular-nums">
              {display}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="edit default run budget"
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              <Pencil size={11} />
            </button>
          </div>
        )}
      </div>
      {save.isError ? (
        <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
          {(save.error as Error).message}
        </div>
      ) : null}
      {overridden ? (
        <button
          type="button"
          onClick={() => clearOverride.mutate()}
          className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)] underline hover:text-[var(--color-fg-1)]"
        >
          revert to yaml default
        </button>
      ) : null}
    </div>
  );
}

function GithubTokenRow({ has }: { has: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const save = useMutation({
    mutationFn: (v: string) => trpc.settings.set.mutate({ key: "github-token" as never, value: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      qc.invalidateQueries({ queryKey: ["projects.hasGithubToken"] });
      setDraft("");
      setEditing(false);
    },
  });

  const clearToken = useMutation({
    mutationFn: () => trpc.settings.set.mutate({ key: "github-token" as never, value: "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      qc.invalidateQueries({ queryKey: ["projects.hasGithubToken"] });
    },
  });

  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-[var(--color-fg-1)]">github token</span>
        {has ? (
          <span className="chip chip-greenlit">configured</span>
        ) : (
          <span className="mono text-[11px] text-[var(--color-fg-3)]">not set</span>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="ghp_…"
            className="flex-1 mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
          />
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || !draft}
            aria-label="save token"
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setEditing(false);
            }}
            aria-label="cancel"
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            {has ? "replace" : "add"}
          </button>
          {has ? (
            <button
              type="button"
              onClick={() => clearToken.mutate()}
              disabled={clearToken.isPending}
              className="btn btn-ghost text-[11px] !h-7 !px-2"
            >
              clear
            </button>
          ) : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            stored in db; needs <code>repo</code> or <code>public_repo</code>
          </span>
        </div>
      )}
      {save.isError ? (
        <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
          {(save.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

function FactoryProjectRow({
  currentId,
  overridden,
  projects,
}: {
  currentId: string | null;
  overridden: boolean;
  projects: ProjectRow[];
}) {
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (id: string) =>
      trpc.settings.set.mutate({ key: "factory-project-id" as never, value: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
    },
  });

  const current = projects.find((p) => p.id === currentId);
  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--color-fg-1)]">factory meta-project</span>
          {overridden ? (
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">db</span>
          ) : (
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">yaml</span>
          )}
        </div>
        {save.isPending ? (
          <Loader2 size={11} className="animate-spin text-[var(--color-fg-3)]" />
        ) : null}
      </div>
      <div className="mt-1.5">
        <select
          value={currentId ?? ""}
          onChange={(e) => save.mutate(e.target.value)}
          className="w-full mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1.5"
        >
          <option value="">— none (promote disabled) —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.slug})
            </option>
          ))}
        </select>
      </div>
      {current ? (
        <div className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)] truncate">
          feedback promote-to-plan/task lands here
        </div>
      ) : (
        <div className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)]">
          set this to enable feedback → plan/task promotion
        </div>
      )}
      {save.isError ? (
        <div className="mt-1 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
          {(save.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

function MetricsTotalChip() {
  const summary = useQuery({
    queryKey: ["metrics.summary"],
    queryFn: () =>
      trpc.metrics.summary.query() as unknown as Promise<{
        totals: { totalCostUsd: number; invocations: number };
      }>,
    refetchInterval: 60_000,
  });
  const cost = summary.data?.totals.totalCostUsd ?? 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[12px] tabular-nums text-[var(--color-fg-2)]">
        {cost > 0 ? `$${cost < 0.01 ? "<0.01" : cost.toFixed(2)}` : "—"}
      </span>
      <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
    </div>
  );
}
