import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AgentModelPicker, type AgentName } from "../components/model-picker.tsx";
import { useAuth } from "../lib/auth.ts";
import * as notifications from "../lib/notifications.ts";
import { trpc } from "../lib/trpc.ts";

interface SettingsSnapshot {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  agentBudgetSeconds: number;
  githubToken: { has: boolean };
  githubReplyAllowlist: string[];
  publicBaseUrl: string | null;
  factoryProjectId: string | null;
  notifyOnRunComplete: boolean;
  ops: {
    landingRoute: "inbox" | "ops";
    defaultModel: string | null;
    defaultAgent: string | null;
    experimentalFable5: boolean;
    notifyOnQueueEmpty: boolean;
  };
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
    <div className="space-y-4 md:max-w-3xl md:mx-auto">
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

      <NotificationsSection />

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
            <BudgetRow
              label="default run budget"
              settingKey="default-run-budget-seconds"
              seconds={settings.data.defaultRunBudgetSeconds}
              overridden={settings.data.overridden["default-run-budget-seconds"] ?? false}
            />
            <BudgetRow
              label="agent budget (triage/plan/audit/feedback)"
              settingKey="agent-budget-seconds"
              seconds={settings.data.agentBudgetSeconds}
              overridden={settings.data.overridden["agent-budget-seconds"] ?? false}
            />
            <GithubTokenRow has={settings.data.githubToken.has} />
            <GithubReplyAllowlistRow
              logins={settings.data.githubReplyAllowlist}
              overridden={settings.data.overridden["github-app-reply-allowlist"] ?? false}
            />
            <EditableRow
              label="public base url"
              value={settings.data.publicBaseUrl ?? ""}
              settingKey="public-base-url"
              overridden={settings.data.overridden["public-base-url"] ?? false}
              hint="absolute URL the PWA is reachable at — used for deep links in the GitHub App's issue replies"
            />
            <FactoryProjectRow
              currentId={settings.data.factoryProjectId}
              overridden={settings.data.overridden["factory-project-id"] ?? false}
              projects={projects.data ?? []}
            />
          </>
        )}
      </Section>

      <Section title="dashboard">
        {settings.isLoading || !settings.data ? (
          <div className="px-3 py-3">
            <div className="skel h-3 w-2/3 mb-1.5" />
          </div>
        ) : (
          <DashboardSettingsRows snap={settings.data} />
        )}
      </Section>

      <OperatorMemorySection />

      <Section title="autonomy">
        <Link
          to="/settings/autonomy"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">autonomy policy</span>
          <span className="flex items-center gap-1.5">
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">system</span>
            <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
          </span>
        </Link>
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

      <Section title="library">
        <Link
          to="/settings/task-templates"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">task templates</span>
          <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
        </Link>
      </Section>

      <Section title="about">
        <Link
          to="/settings/release-notes"
          className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
        >
          <span className="text-[13px] text-[var(--color-fg-1)]">release notes</span>
          <span className="flex items-center gap-1.5">
            <span className="mono text-[11px] text-[var(--color-fg-2)] tabular-nums">
              v{__FACTORY_VERSION__}
            </span>
            <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
          </span>
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

/**
 * Operator-memory seed (ADR-010 §4). One click kicks off a background synthesis
 * of the operator's existing harness memories (Claude Code / Codex) into
 * operator-memory facts. It's token-heavy and slow, so the daemon runs it in the
 * background and the click returns only the harness sources it will read — the
 * operator watches /memory fill. Empty `sources` means no harness memories were
 * found on this host.
 */
function OperatorMemorySection() {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const seed = useMutation({
    mutationFn: () => trpc.memory.seed.mutate(),
    onSuccess: (res) => {
      setConfirmation(
        res.sources.length > 0
          ? `seeding from ${res.sources.join(", ")}… watch /memory fill.`
          : "no harness memories found on this host.",
      );
    },
  });

  return (
    <Section title="operator memory">
      <div className="px-3 py-2.5 border-b border-[var(--color-line)]">
        <button
          type="button"
          onClick={() => {
            setConfirmation(null);
            seed.mutate();
          }}
          disabled={seed.isPending}
          className="btn w-full"
        >
          {seed.isPending ? (
            <span className="flex items-center justify-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              seeding…
            </span>
          ) : (
            "seed from harness memories"
          )}
        </button>
        <p className="mt-2 text-[10.5px] mono text-[var(--color-fg-3)] leading-relaxed">
          synthesizes your Claude Code / Codex memories into operator-memory facts. token-heavy;
          runs in the background — watch{" "}
          <Link to="/memory" className="text-[var(--color-accent)] underline">
            /memory
          </Link>{" "}
          fill.
        </p>
        {seed.isError ? (
          <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
            {(seed.error as Error).message}
          </div>
        ) : null}
        {confirmation ? (
          <p className="mt-1.5 mono text-[10.5px] text-[var(--color-fg-2)] leading-relaxed">
            {confirmation}
          </p>
        ) : null}
      </div>
      <Link
        to="/memory"
        className="px-3 h-11 flex items-center justify-between border-b border-[var(--color-line)] last:border-b-0 active:bg-[var(--color-bg-2)]"
      >
        <span className="text-[13px] text-[var(--color-fg-1)]">view operator memory</span>
        <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
      </Link>
    </Section>
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
 * Budget row with an explicit ∞ affordance. 0 = infinite (matches running
 * `claude` directly). When the chip is toggled on, the number is locked
 * to 0 and the read-only state shows "infinite" instead of "0s".
 */
function BudgetRow({
  label,
  settingKey,
  seconds,
  overridden,
}: {
  label: string;
  settingKey: string;
  seconds: number;
  overridden: boolean;
}) {
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
      trpc.settings.set.mutate({ key: settingKey as never, value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
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

  const display = seconds === 0 ? "infinite" : `${seconds}s`;
  const nextValue = infinite ? "0" : draft;
  const dirty = nextValue !== String(seconds);

  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-[var(--color-fg-1)] truncate">{label}</span>
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

/**
 * GitHub logins the Factory App will answer when they comment on a tracked
 * issue (repo collaborators are always answered, listed or not). Comma- or
 * space-separated; stored normalized in the DB.
 */
function GithubReplyAllowlistRow({
  logins,
  overridden,
}: {
  logins: string[];
  overridden: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const joined = logins.join(", ");
  const [draft, setDraft] = useState(joined);
  useEffect(() => {
    setDraft(joined);
  }, [joined]);

  const save = useMutation({
    mutationFn: (v: string) =>
      trpc.settings.set.mutate({ key: "github-app-reply-allowlist" as never, value: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      setEditing(false);
    },
  });

  return (
    <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-[var(--color-fg-1)]">issue reply allowlist</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {overridden ? "db" : "default"}
          </span>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="octocat, hubot"
            className="flex-1 mono text-[12px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-1"
          />
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || draft === joined}
            aria-label="save allowlist"
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(joined);
              setEditing(false);
            }}
            aria-label="cancel"
            className="btn btn-ghost text-[11px] !h-7 !px-2"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div className="mt-1 mono text-[11px] text-[var(--color-fg-2)] truncate">
          {logins.length > 0 ? joined : "— none —"}
        </div>
      )}
      {save.isError ? (
        <div className="mt-1.5 mono text-[10.5px] text-[var(--color-verdict-trashed)]">
          {(save.error as Error).message}
        </div>
      ) : null}
      <div className="mt-1 mono text-[10.5px] text-[var(--color-fg-3)] leading-relaxed">
        the GitHub App answers issue comments from these logins. repo collaborators
        (owner/member/collaborator) are always answered.
      </div>
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
          <span className="text-[13px] text-[var(--color-fg-1)]">Heimdall meta-project</span>
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

interface NotificationStatusView {
  supported: boolean;
  secure: boolean;
  permission: "default" | "granted" | "denied" | "unsupported";
  subscribed: boolean;
}

function NotificationsSection() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<NotificationStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void notifications.getStatus().then(setStatus);
  }, []);

  const devices = useQuery({
    queryKey: ["notifications.listDevices"],
    queryFn: () => trpc.notifications.listDevices.query(),
    enabled: status?.subscribed === true,
    refetchInterval: 30_000,
  });

  const enable = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await notifications.enable();
      setStatus(next);
      await qc.invalidateQueries({ queryKey: ["notifications.listDevices"] });
      setInfo("notifications enabled on this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await notifications.disable();
      setStatus(next);
      await qc.invalidateQueries({ queryKey: ["notifications.listDevices"] });
      setInfo("notifications disabled on this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await notifications.sendTest();
      if (res.failed === 0) {
        setInfo(`test push sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.`);
      } else {
        // Render the per-device failure detail inline so the operator
        // can tell APNs-rejected from FCM-rejected from "VAPID subject
        // wrong" without having to ssh into the host. Shows status code,
        // host (apns vs fcm vs mozilla), and the first chunk of the
        // response body if the push service returned one.
        const lines = res.errors.map((e) => {
          const host = e.endpointHost ?? "unknown host";
          const status = e.statusCode != null ? `${e.statusCode}` : "?";
          const snippet = e.responseSnippet ? ` — ${e.responseSnippet}` : "";
          return `[${host}] ${status}: ${e.message}${snippet}`;
        });
        setError(`sent: ${res.sent} · failed: ${res.failed}\n${lines.join("\n")}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = useMutation({
    mutationFn: (id: string) => trpc.notifications.removeDevice.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications.listDevices"] });
    },
  });

  // Reuses the same query key the parent Settings component already polls, so
  // react-query dedupes — no extra fetch.
  const settings = useQuery({
    queryKey: ["settings.get"],
    queryFn: () => trpc.settings.get.query() as unknown as Promise<SettingsSnapshot>,
  });
  const notifyOnRunComplete = settings.data?.notifyOnRunComplete ?? false;
  const toggleRunComplete = useMutation({
    mutationFn: (next: boolean) =>
      trpc.settings.set.mutate({
        key: "notify-on-run-complete" as never,
        value: next ? "true" : "false",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings.get"] }),
  });

  return (
    <Section title="notifications">
      <Row label="status">
        {status === null ? (
          <span className="chip">probing…</span>
        ) : !status.supported ? (
          <span className="chip">unsupported</span>
        ) : !status.secure ? (
          <span className="chip chip-trashed">needs https</span>
        ) : status.permission === "denied" ? (
          <span className="chip chip-trashed">blocked</span>
        ) : status.subscribed ? (
          <span className="chip chip-greenlit">on</span>
        ) : (
          <span className="chip">off</span>
        )}
      </Row>

      {status && !status.supported ? (
        <p className="px-3 pb-3 pt-1 text-[10.5px] mono text-[var(--color-fg-3)] leading-relaxed">
          this browser doesn't expose the Push API. on iOS, web push works only after you add
          Heimdall to the home screen and open it from there.
        </p>
      ) : null}

      {status?.supported && !status.secure ? (
        <p className="px-3 pb-3 pt-1 text-[10.5px] mono text-[var(--color-fg-3)] leading-relaxed">
          web push needs an https origin (or http://localhost). put the daemon behind a reverse
          proxy with a cert and try again from the https URL.
        </p>
      ) : null}

      {status?.supported && status.secure ? (
        <div className="px-3 pb-3 pt-2 space-y-2">
          {!status.subscribed ? (
            <button
              type="button"
              onClick={enable}
              disabled={busy || status.permission === "denied"}
              className="btn w-full"
            >
              {busy ? "enabling…" : "enable on this device"}
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={sendTest} disabled={busy} className="btn flex-1">
                {busy ? "…" : "send test"}
              </button>
              <button
                type="button"
                onClick={disable}
                disabled={busy}
                className="btn btn-danger flex-1"
              >
                disable here
              </button>
            </div>
          )}
          {status.permission === "denied" ? (
            <p className="text-[10.5px] mono text-[var(--color-verdict-trashed)] leading-relaxed">
              browser permission was denied. open browser/site settings and re-allow notifications,
              then reload.
            </p>
          ) : null}
          {error ? (
            <pre className="text-[10.5px] mono text-[var(--color-verdict-trashed)] leading-relaxed whitespace-pre-wrap break-words">
              {error}
            </pre>
          ) : null}
          {info ? (
            <p className="text-[10.5px] mono text-[var(--color-fg-2)] leading-relaxed">{info}</p>
          ) : null}
        </div>
      ) : null}

      {status?.supported && status.secure ? (
        <div className="border-t border-[var(--color-line)]">
          <Row label="run-complete push">
            <button
              type="button"
              onClick={() => toggleRunComplete.mutate(!notifyOnRunComplete)}
              disabled={toggleRunComplete.isPending || settings.isLoading}
              className={`chip ${notifyOnRunComplete ? "chip-greenlit" : ""}`}
            >
              {notifyOnRunComplete ? "on" : "off"}
            </button>
          </Row>
          <p className="px-3 pb-2 pt-1 text-[10.5px] mono text-[var(--color-fg-3)] leading-relaxed">
            push every time a run finishes. blocked, failed, and merge-failed runs always push
            regardless of this setting.
          </p>
        </div>
      ) : null}

      {status?.subscribed && devices.data && devices.data.length > 0 ? (
        <div className="border-t border-[var(--color-line)]">
          <div className="px-3 pt-2 pb-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            enrolled devices ({devices.data.length})
          </div>
          <ul className="divide-y divide-[var(--color-line)]">
            {devices.data.map((d) => (
              <li key={d.id} className="px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-[var(--color-fg-1)] truncate">
                    {summarizeUa(d.ua)}
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
                    last push {fmtRelative(d.lastSeenAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeDevice.mutate(d.id)}
                  className="chip chip-trashed text-[10.5px]"
                  disabled={removeDevice.isPending}
                  aria-label="remove device"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

function summarizeUa(ua: string | null): string {
  if (!ua) return "unknown device";
  const isMobile = /iPhone|iPad|Android/i.test(ua);
  if (/iPhone/.test(ua)) return "iPhone (Safari)";
  if (/iPad/.test(ua)) return "iPad (Safari)";
  if (/Android/.test(ua) && /Chrome/.test(ua)) return "Android (Chrome)";
  if (/Edg\//.test(ua)) return isMobile ? "Edge (mobile)" : "Edge (desktop)";
  if (/Chrome/.test(ua)) return isMobile ? "Chrome (mobile)" : "Chrome (desktop)";
  if (/Firefox/.test(ua)) return isMobile ? "Firefox (mobile)" : "Firefox (desktop)";
  if (/Safari/.test(ua)) return isMobile ? "Safari (mobile)" : "Safari (desktop)";
  return "browser";
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function DashboardSettingsRows({ snap }: { snap: SettingsSnapshot }) {
  const qc = useQueryClient();
  const setLanding = useMutation({
    mutationFn: (value: "inbox" | "ops") =>
      trpc.settings.set.mutate({ key: "landing-route" as never, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
    },
  });
  const setDefaultModel = useMutation({
    mutationFn: (modelId: string | null) =>
      trpc.settings.set.mutate({ key: "default-model" as never, value: modelId ?? "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
    },
  });
  const setDefaultAgent = useMutation({
    mutationFn: (agent: AgentName) =>
      trpc.settings.set.mutate({ key: "default-agent" as never, value: agent }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
    },
  });
  const setFable5 = useMutation({
    mutationFn: (on: boolean) =>
      trpc.settings.set.mutate({
        key: "experimental-fable-5" as never,
        value: on ? "true" : "false",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
      // Refresh the model picker so Fable 5 appears/disappears immediately.
      qc.invalidateQueries({ queryKey: ["agents.list"] });
    },
  });
  const setQueueEmpty = useMutation({
    mutationFn: (on: boolean) =>
      trpc.settings.set.mutate({
        key: "notify-on-queue-empty" as never,
        value: on ? "true" : "false",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings.get"] });
    },
  });
  const saving = setDefaultModel.isPending || setDefaultAgent.isPending;
  return (
    <>
      <div className="px-3 py-2 border-b border-[var(--color-line)]">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[13px] text-[var(--color-fg-1)]">landing page</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            opens when you tap Heimdall
          </span>
        </div>
        <div className="flex gap-1">
          {(["inbox", "ops"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setLanding.mutate(opt)}
              disabled={setLanding.isPending}
              className={`chip ${snap.ops.landingRoute === opt ? "chip-accent" : ""}`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[13px] text-[var(--color-fg-1)]">default agent + model</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            system default · projects + tasks override
          </span>
        </div>
        <AgentModelPicker
          agent={(snap.ops.defaultAgent as AgentName | null) ?? null}
          model={snap.ops.defaultModel}
          onAgentChange={(agent) => {
            // Switching agent invalidates the current model selection — codex
            // and claude have disjoint model ids. Reset model to "default" so
            // the next layer down picks for the new agent.
            setDefaultAgent.mutate(agent);
            if (snap.ops.defaultModel !== null) setDefaultModel.mutate(null);
          }}
          onModelChange={(id) => setDefaultModel.mutate(id)}
          disabled={saving}
        />
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-1">
          inheritance: task → project → this → claude-code (CLI default)
        </p>
      </div>

      <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[13px] text-[var(--color-fg-1)]">experimental: fable 5</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            adds fable 5 to the claude model picker
          </span>
        </div>
        <div className="flex gap-1">
          {([true, false] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              onClick={() => setFable5.mutate(on)}
              disabled={setFable5.isPending}
              className={`chip ${snap.ops.experimentalFable5 === on ? "chip-accent" : ""}`}
            >
              {on ? "on" : "off"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-[var(--color-line)] last:border-b-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[13px] text-[var(--color-fg-1)]">notify on empty queue</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            inbox nudge when a project runs out of ready tasks
          </span>
        </div>
        <div className="flex gap-1">
          {([true, false] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              onClick={() => setQueueEmpty.mutate(on)}
              disabled={setQueueEmpty.isPending}
              className={`chip ${snap.ops.notifyOnQueueEmpty === on ? "chip-accent" : ""}`}
            >
              {on ? "on" : "off"}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
