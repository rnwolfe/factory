import { useQuery } from "@tanstack/react-query";
import { FolderInput, Layers, ListChecks } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { AutoChip } from "../components/auto-chip.tsx";
import { TrustLadder } from "../components/trust-ladder.tsx";
import { trpc } from "../lib/trpc.ts";

const TAGS = ["active", "background", "past"] as const;
const VISIBLE_TAGS = ["active", "background"] as const;

// One row of the portfolio. Mirrors `projects.list`'s return shape so the new
// Heimdall signals (live activity counts, trust ladder, today's merge stats)
// stay in lockstep with the router without a hand-maintained interface.
type ProjectRow = Awaited<ReturnType<typeof trpc.projects.list.query>>[number];

export function Projects() {
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query(),
    refetchInterval: 10_000,
  });

  if (list.isLoading) return <ProjectsSkeleton />;

  const allRows = list.data ?? [];
  const rows = showArchived
    ? allRows
    : allRows.filter((r) => (VISIBLE_TAGS as readonly string[]).includes(r.tag));
  const archivedCount = allRows.filter((r) => r.tag === "past").length;

  if (rows.length === 0 && allRows.length === 0) {
    return (
      <div className="space-y-3">
        <div className="surface p-6 text-center">
          <Layers size={28} className="mx-auto text-[var(--color-fg-3)] mb-2" />
          <div className="display text-lg mb-1">no projects yet</div>
          <p className="text-sm text-[var(--color-fg-2)]">
            approve a greenlit decision to spawn one — or import an existing repo.
          </p>
        </div>
        <Link to="/projects/import" className="btn btn-primary w-full">
          <FolderInput size={14} /> import existing project
        </Link>
      </div>
    );
  }

  const grouped = TAGS.map((t) => ({
    tag: t,
    rows: rows.filter((r) => r.tag === t),
  })).filter((g) => g.rows.length > 0);

  // Summary strip: working = something actually running now; idle = the rest.
  // We have no per-project "needs you" signal in this payload, so we omit that
  // segment rather than invent one — amber stays a budget, unspent here.
  const workingCount = rows.filter((r) => (r.runningRunCount ?? 0) > 0).length;
  const idleCount = rows.length - workingCount;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between px-1">
        <h1 className="display text-lg text-[var(--color-fg)]">projects</h1>
        <span className="mono text-[11px] text-[var(--color-fg-3)]">+{rows.length}</span>
      </div>
      <div className="flex items-center gap-2 px-1 mono text-[11px] -mt-3">
        <span className="text-[var(--color-working)]">{workingCount} working</span>
        <span className="text-[var(--color-fg-3)]">·</span>
        <span className="text-[var(--color-fg-3)]">{idleCount} idle</span>
      </div>
      <div className="flex gap-2">
        <Link to="/tasks" className="btn btn-ghost flex-1">
          <ListChecks size={14} /> open tasks
        </Link>
        <Link to="/projects/import" className="btn btn-ghost flex-1">
          <FolderInput size={14} /> import project
        </Link>
      </div>
      {archivedCount > 0 ? (
        <label className="flex items-center justify-end gap-1.5 text-[11.5px] text-[var(--color-fg-2)] cursor-pointer px-1">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>show archived ({archivedCount})</span>
        </label>
      ) : null}
      {grouped.map((g) => (
        <section key={g.tag}>
          <div className="flex items-center gap-2 px-1 mb-1.5">
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              {g.tag}
            </span>
            <div className="hairline flex-1" />
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{g.rows.length}</span>
          </div>
          <div className="surface divide-y divide-[var(--color-line)]">
            {g.rows.map((p) => (
              <ProjectRowLink key={p.id} p={p} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProjectRowLink({ p }: { p: ProjectRow }) {
  const mergedPct = p.stats.mergedPct;
  return (
    <Link
      to={`/projects/${p.id}`}
      className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)] active:bg-[var(--color-bg-3)]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="display text-[15px] text-[var(--color-fg)] truncate">{p.name}</div>
          <div className="mono text-[11px] text-[var(--color-fg-3)] truncate">
            {p.slug} · {p.ceremony} · {p.role}
            {p.license ? ` · ${p.license}` : ""}
          </div>
        </div>
        <ActivityChip running={p.runningRunCount ?? 0} autoMerged={p.stats.autoMergedToday} />
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <TrustLadder
          rung={p.trust.rung}
          streak={p.trust.cleanStreak}
          target={p.trust.promoteStreak}
          size="inline"
        />
        <span className="mono text-[10.5px] text-[var(--color-fg-3)] shrink-0">
          {p.queuedRunCount}q{mergedPct !== null ? ` · ${mergedPct}% merged` : ""}
        </span>
      </div>
    </Link>
  );
}

function ActivityChip({ running, autoMerged }: { running: number; autoMerged: number }) {
  // Right-edge live state, one signal in priority order. Running is the working
  // voice — TEAL, never amber (amber is reserved for "a decision is yours", of
  // which this screen has none). An unattended merge today reads as the `auto`
  // marker; otherwise the project is idle.
  if (running > 0) {
    return (
      <span className="chip chip-working shrink-0" title={`${running} running`}>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-working)] mr-1 pulse-dot"
          aria-hidden="true"
        />
        {running} running
      </span>
    );
  }
  if (autoMerged > 0) {
    return <AutoChip>auto · {autoMerged} merged</AutoChip>;
  }
  return <span className="mono text-[10.5px] text-[var(--color-fg-3)] shrink-0">idle</span>;
}

function ProjectsSkeleton() {
  const slots = ["s1", "s2", "s3", "s4", "s5"] as const;
  return (
    <div className="space-y-2.5">
      {slots.map((id) => (
        <div key={id} className="surface px-3 py-2.5">
          <div className="skel h-4 w-2/3 mb-1.5" />
          <div className="skel h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
