import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  FileText,
  GitMerge,
  Plus,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AttentionHeader } from "../components/attention-header.tsx";
import { AuditCard, type AuditRow } from "../components/audit-card.tsx";
import { AutoChip } from "../components/auto-chip.tsx";
import { DecisionCard, type DecisionRow } from "../components/decision-card.tsx";
import { HeimdallMark } from "../components/heimdall-mark.tsx";
import { PlanCard, type PlanRow } from "../components/plan-card.tsx";
import { trpc } from "../lib/trpc.ts";
import { useRawSocket } from "../lib/use-channel.ts";
import { AuditPane } from "./audit-pane.tsx";
import { DecisionDetail } from "./decision-detail.tsx";
import { FeedbackDetail } from "./feedback-detail.tsx";
import { PlanDetail } from "./plan-detail.tsx";

interface AmbientRun {
  runId: string;
  projectId: string;
  projectName: string | null;
  projectSlug: string | null;
  taskId: string | null;
  status: string;
  startedAt: number;
  iterationCount: number;
  budgetSeconds: number;
  agentName: string;
}
interface AmbientEvent {
  id: string;
  kind: string;
  message: string;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  runId: string | null;
  createdAt: number;
}
interface OpsSnapshotLite {
  running: unknown[];
  queued: unknown[];
  usage: { today: { totalCostUsd: number } };
}

interface FeedbackInboxRow {
  id: string;
  vote: "up" | "down";
  body: string;
  contextHint: string | null;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  snoozedUntil?: number | null;
  createdAt: number;
}

interface TriagingIdea {
  id: string;
  rawText: string;
  intentCeremony: string | null;
  intentRole: string | null;
  source: string;
  createdAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
}

type InboxItem =
  | { kind: "decision"; row: DecisionRow }
  | { kind: "plan"; row: PlanRow }
  | { kind: "audit"; row: AuditRow }
  | { kind: "feedback"; row: FeedbackInboxRow };

// The item currently open in the desktop reading pane. Audits need their
// projectId too, since the report is fetched per (project, audit).
type SelectedItem =
  | { kind: "decision" | "plan" | "feedback"; id: string }
  | { kind: "audit"; id: string; projectId: string };

function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
}

type InboxView = "active" | "snoozed";
type SnoozeTarget = InboxItem["kind"];
type SnoozeVars = { kind: SnoozeTarget; id: string; snoozedUntil: number | null };
type SnoozeContext = { queryKey: QueryKey; prev?: Array<{ id: string }> };

const SNOOZE_PRESETS = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "tomorrow", ms: 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "3 weeks", ms: 21 * 24 * 60 * 60 * 1000 },
] as const;

export function Inbox() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [view, setView] = useState<InboxView>("active");
  // Desktop reading pane (Gmail-style): a row click on a wide viewport opens the
  // item's full detail here beside the list instead of navigating away. On
  // phone widths there's no room, so clicks navigate to the full route (the
  // phone-first invariant). null = nothing open yet.
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  const inbox = useQuery({
    queryKey: ["decisions.inbox", view],
    queryFn: () => trpc.decisions.inbox.query({ view }) as unknown as Promise<DecisionRow[]>,
    refetchInterval: 6_000,
  });

  const planInbox = useQuery({
    queryKey: ["plans.inbox", view],
    queryFn: () => trpc.plans.inbox.query({ view }) as unknown as Promise<PlanRow[]>,
    refetchInterval: 6_000,
  });

  const auditInbox = useQuery({
    queryKey: ["audits.inbox", view],
    queryFn: () => trpc.audits.inbox.query({ view }) as unknown as Promise<AuditRow[]>,
    refetchInterval: 6_000,
  });

  const feedbackInbox = useQuery({
    queryKey: ["feedback.inbox", view],
    queryFn: () => trpc.feedback.inbox.query({ view }) as unknown as Promise<FeedbackInboxRow[]>,
    refetchInterval: 6_000,
  });

  const projectsList = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query() as unknown as Promise<ProjectRow[]>,
    enabled: (auditInbox.data?.length ?? 0) > 0,
  });

  const triaging = useQuery({
    queryKey: ["ideas.triaging"],
    queryFn: () => trpc.ideas.triaging.query() as unknown as Promise<TriagingIdea[]>,
    refetchInterval: 6_000,
  });

  const ideasList = useQuery({
    queryKey: ["ideas.list"],
    queryFn: () => trpc.ideas.list.query(),
    enabled: inbox.data && inbox.data.length > 0,
  });

  // Ambient context — what the system is doing / did on its own. Powers the
  // "in flight" (live runs) and "done while you were away" (unattended) groups.
  const ambient = useQuery({
    queryKey: ["decisions.ambient"],
    queryFn: () =>
      trpc.decisions.ambient.query() as unknown as Promise<{
        inFlight: AmbientRun[];
        unattended: AmbientEvent[];
      }>,
    refetchInterval: 6_000,
  });

  // The watch strip's ambient counters (running / queued / spend today).
  const opsSnap = useQuery({
    queryKey: ["ops.snapshot"],
    queryFn: () => trpc.ops.snapshot.query() as unknown as Promise<OpsSnapshotLite>,
    refetchInterval: 30_000,
  });

  // Live push: subscribe to /ws/inbox for instant updates. Reconnect/backoff
  // discipline lives in useRawSocket; polling above stays as the safety net.
  useRawSocket("/ws/inbox", () => {
    // Coarse invalidation — inbox + plan inbox + triaging + audit + feedback
    // all refetch on any inbox-channel event. Set is small and queries
    // are cheap.
    qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
    qc.invalidateQueries({ queryKey: ["plans.inbox"] });
    qc.invalidateQueries({ queryKey: ["audits.inbox"] });
    qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
    qc.invalidateQueries({ queryKey: ["ideas.triaging"] });
    qc.invalidateQueries({ queryKey: ["decisions.ambient"] });
    // Push the shared "needs you" badge count too, so every badge surface
    // updates on inbox-channel events instead of waiting for its slow poll.
    qc.invalidateQueries({ queryKey: ["decisions.needsYouCount"] });
  });

  const action = useMutation({
    mutationFn: (vars: {
      decisionId: string;
      action: "approve" | "park" | "trash" | "decompose" | "dismiss" | "scaffold_skill";
      selectedIssues?: number[];
      note?: string;
    }) => trpc.decisions.action.mutate(vars),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["decisions.inbox", view] });
      const prev = qc.getQueryData<DecisionRow[]>(["decisions.inbox", view]);
      qc.setQueryData<DecisionRow[]>(["decisions.inbox", view], (rows) =>
        (rows ?? []).filter((r) => r.id !== vars.decisionId),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["decisions.inbox", view], ctx.prev);
    },
    onSuccess: (res) => {
      // Approving a triage decision creates a plan; navigate the operator
      // straight into the foundry plan to keep momentum.
      if (res?.planId) {
        nav(`/plans/${res.planId}`);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
    },
  });

  const snooze = useMutation<unknown, Error, SnoozeVars, SnoozeContext>({
    mutationFn: async (vars) => {
      const input = { id: vars.id, snoozedUntil: vars.snoozedUntil };
      switch (vars.kind) {
        case "decision":
          await trpc.decisions.snooze.mutate(input);
          return;
        case "plan":
          await trpc.plans.snooze.mutate(input);
          return;
        case "audit":
          await trpc.audits.snooze.mutate(input);
          return;
        case "feedback":
          await trpc.feedback.snooze.mutate(input);
          return;
      }
    },
    onMutate: async (vars) => {
      const queryKey =
        vars.kind === "decision"
          ? ["decisions.inbox", view]
          : vars.kind === "plan"
            ? ["plans.inbox", view]
            : vars.kind === "audit"
              ? ["audits.inbox", view]
              : ["feedback.inbox", view];
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<Array<{ id: string }>>(queryKey);
      qc.setQueryData<Array<{ id: string }>>(queryKey, (rows) =>
        (rows ?? []).filter((r) => r.id !== vars.id),
      );
      return { queryKey, prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.queryKey, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["audits.inbox"] });
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
    },
  });

  const handleSnooze = useCallback(
    (kind: SnoozeTarget, id: string, snoozedUntil: number | null) => {
      snooze.mutate({ kind, id, snoozedUntil });
    },
    [snooze],
  );

  // Dismiss "done while you were away" FYI rows. These are ambient autonomy
  // events, not decisions — acknowledging hides them from the digest (the
  // event stays in the /ops log). Optimistically drop the acknowledged ids
  // from the cached `ambient.unattended` list so the row leaves instantly.
  const acknowledgeAmbient = useMutation<unknown, Error, string[], { prev?: unknown }>({
    mutationFn: (ids) => trpc.decisions.acknowledgeAmbient.mutate({ ids }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["decisions.ambient"] });
      const prev = qc.getQueryData(["decisions.ambient"]);
      const drop = new Set(ids);
      qc.setQueryData<{ inFlight: AmbientRun[]; unattended: AmbientEvent[] }>(
        ["decisions.ambient"],
        (data) =>
          data ? { ...data, unattended: data.unattended.filter((e) => !drop.has(e.id)) } : data,
      );
      return { prev };
    },
    onError: (_e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(["decisions.ambient"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["decisions.ambient"] });
    },
  });

  // Triaging ideas are live work, not snoozed items — only show them in the
  // active view.
  const triagingRows = view === "active" ? (triaging.data ?? []) : [];

  if (inbox.isLoading && triagingRows.length === 0 && !planInbox.data) {
    return <InboxSkeleton />;
  }
  // Only dead-end on the INITIAL failure (nothing ever loaded). Once we have
  // data, a transient failure — e.g. the ~3s blip during a daemon upgrade —
  // keeps rendering the last-good inbox; the 6s poll auto-recovers, and the
  // `reconnecting` pill (below) signals the stale state. This stops a routine
  // restart from throwing the operator onto a hard error screen.
  if (inbox.isError && !inbox.data) {
    return (
      <div className="surface p-4 text-sm">
        <div className="display text-[var(--color-fg)] mb-1">can't reach Heimdall</div>
        <div className="text-[var(--color-fg-2)] mb-3">
          {(inbox.error as Error).message}. Usually a brief blip (like a restart) — retrying
          automatically.
        </div>
        <button
          type="button"
          onClick={() => {
            inbox.refetch();
            planInbox.refetch();
            auditInbox.refetch();
            feedbackInbox.refetch();
            ambient.refetch();
          }}
          disabled={inbox.isFetching}
          className="btn btn-primary"
        >
          {inbox.isFetching ? "reconnecting…" : "retry"}
        </button>
      </div>
    );
  }

  // A background refetch failed but we still have last-good data — show a subtle,
  // non-blocking pill instead of blanking the inbox.
  const reconnecting = inbox.isError && !!inbox.data;

  const decisionRows = inbox.data ?? [];
  const planRows = planInbox.data ?? [];
  const auditRows = auditInbox.data ?? [];
  const feedbackRows = feedbackInbox.data ?? [];
  const ideasById = new Map(ideasList.data?.map((i) => [i.id, i.rawText]) ?? []);
  const projectNameById = new Map(projectsList.data?.map((p) => [p.id, p.name]) ?? []);

  // Merge by sortable timestamp descending. Audits sort by completedAt
  // (falling back to startedAt) since that's when they entered the inbox.
  const merged: InboxItem[] = [
    ...decisionRows.map((row) => ({ kind: "decision" as const, row, ts: row.createdAt })),
    ...planRows.map((row) => ({ kind: "plan" as const, row, ts: row.createdAt })),
    ...auditRows.map((row) => ({
      kind: "audit" as const,
      row,
      ts: row.completedAt ?? row.startedAt,
    })),
    ...feedbackRows.map((row) => ({ kind: "feedback" as const, row, ts: row.createdAt })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .map(({ ts: _ts, ...rest }) => rest as InboxItem);

  // Ambient groups only show in the active view (they're never "snoozed").
  const inFlight = view === "active" ? (ambient.data?.inFlight ?? []) : [];
  const unattended = view === "active" ? (ambient.data?.unattended ?? []) : [];

  // Drop the pane selection if its item left the list (e.g. the operator
  // approved/dismissed it, or it snoozed out of view). Set-during-render is
  // safe when next state is null and depends only on current props/state.
  const selectedStillPresent =
    selected !== null && merged.some((m) => m.kind === selected.kind && m.row.id === selected.id);
  if (selected !== null && !selectedStillPresent) {
    setSelected(null);
  }

  if (
    merged.length === 0 &&
    triagingRows.length === 0 &&
    inFlight.length === 0 &&
    unattended.length === 0
  ) {
    if (view === "snoozed") {
      return (
        <div>
          <ViewToggle view={view} onChange={setView} />
          <div className="px-2 pt-8 text-center">
            <div className="display text-2xl text-[var(--color-fg)] mb-2">nothing snoozed</div>
            <p className="text-[var(--color-fg-2)] text-sm leading-relaxed">
              no inbox items are currently snoozed — they'll resurface here when their timer is
              running.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div>
        <ViewToggle view={view} onChange={setView} />
        <div className="px-2 pt-8 text-center">
          <div className="display text-2xl text-[var(--color-fg)] mb-2">no decisions</div>
          <p className="text-[var(--color-fg-2)] text-sm leading-relaxed mb-6">
            the inbox is empty. capture an idea — Heimdall triages within ~2 min.
          </p>
          <div className="flex flex-col gap-2 items-center">
            <Link to="/inbox/new" className="btn btn-bright">
              <Plus size={16} /> new idea
            </Link>
            <Link
              to="/inbox/import-spec"
              className="mono text-[11.5px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] flex items-center gap-1.5 mt-1"
            >
              <FileText size={11} /> or import an existing spec
            </Link>
            <Link
              to="/history"
              className="mono text-[11.5px] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] mt-2"
            >
              view history →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // On desktop a row click opens the item's full detail in the reading pane
  // beside the list (Gmail-style — the pane shows *all* the data, the same
  // component the full route renders, not a truncated preview). On phone widths
  // there's no room for a pane, so the click navigates to the full route.
  const openDecision = (row: DecisionRow) => {
    if (isDesktopViewport()) setSelected({ kind: "decision", id: row.id });
    else nav(`/decisions/${row.id}`);
  };
  const openPlan = (row: PlanRow) => {
    if (isDesktopViewport()) setSelected({ kind: "plan", id: row.id });
    else nav(`/plans/${row.id}`);
  };
  const openAudit = (row: AuditRow) => {
    if (isDesktopViewport()) setSelected({ kind: "audit", id: row.id, projectId: row.projectId });
    else nav(`/projects/${row.projectId}/audits/${row.id}`);
  };
  const openFeedback = (row: FeedbackInboxRow) => {
    if (isDesktopViewport()) setSelected({ kind: "feedback", id: row.id });
    else nav(`/feedback/${row.id}`);
  };

  // One inbox item → its card. Shared between the grouped active view and the
  // flat snoozed view. On desktop the card matching the open pane is ringed.
  const renderItem = (item: InboxItem, i: number) => {
    const isSelected =
      selected !== null && selected.kind === item.kind && selected.id === item.row.id;
    if (item.kind === "decision") {
      const d = item.row;
      return (
        <SelectableWrapper key={d.id} active={isSelected}>
          <DecisionCard
            decision={d}
            ideaText={d.ideaId ? (ideasById.get(d.ideaId) ?? null) : null}
            index={i}
            onAction={(a) => action.mutate({ decisionId: d.id, action: a })}
            onOpen={() => openDecision(d)}
            snoozeControl={
              <SnoozeControl
                view={view}
                disabled={snooze.isPending}
                snoozedUntil={d.snoozedUntil ?? null}
                onSnooze={(until) => handleSnooze("decision", d.id, until)}
              />
            }
          />
        </SelectableWrapper>
      );
    }
    if (item.kind === "plan") {
      const p = item.row;
      return (
        <SelectableWrapper key={p.id} active={isSelected}>
          <PlanCard
            plan={p}
            index={i}
            onOpen={() => openPlan(p)}
            snoozeControl={
              <SnoozeControl
                view={view}
                disabled={snooze.isPending}
                snoozedUntil={p.snoozedUntil ?? null}
                onSnooze={(until) => handleSnooze("plan", p.id, until)}
              />
            }
          />
        </SelectableWrapper>
      );
    }
    if (item.kind === "feedback") {
      return (
        <SelectableWrapper key={item.row.id} active={isSelected}>
          <FeedbackCard
            row={item.row}
            onOpen={() => openFeedback(item.row)}
            snoozeControl={
              <SnoozeControl
                view={view}
                disabled={snooze.isPending}
                snoozedUntil={item.row.snoozedUntil ?? null}
                onSnooze={(until) => handleSnooze("feedback", item.row.id, until)}
              />
            }
          />
        </SelectableWrapper>
      );
    }
    const a = item.row;
    return (
      <SelectableWrapper key={a.id} active={isSelected}>
        <AuditCard
          audit={a}
          projectName={projectNameById.get(a.projectId) ?? null}
          index={i}
          onOpen={() => openAudit(a)}
          snoozeControl={
            <SnoozeControl
              view={view}
              disabled={snooze.isPending}
              snoozedUntil={a.snoozedUntil ?? null}
              onSnooze={(until) => handleSnooze("audit", a.id, until)}
            />
          }
        />
      </SelectableWrapper>
    );
  };

  const inFlightCount = triagingRows.length + inFlight.length;

  return (
    <div className="md:grid md:grid-cols-[minmax(340px,420px)_minmax(0,1fr)] md:gap-6 md:items-start">
      {reconnecting ? (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 chip mono text-[10.5px] bg-[var(--color-bg-1)] border border-[var(--color-line)] flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-verdict-parked)] animate-pulse" />
          reconnecting…
        </div>
      ) : null}
      <div className="space-y-3 md:min-w-0">
        <WatchStrip
          running={opsSnap.data?.running.length ?? inFlight.length}
          queued={opsSnap.data?.queued.length ?? 0}
          costToday={opsSnap.data?.usage.today.totalCostUsd ?? 0}
          needYou={merged.length}
        />
        <ViewToggle view={view} onChange={setView} />

        {view === "active" ? (
          <>
            {merged.length > 0 ? (
              <section className="space-y-2.5">
                <AttentionHeader label="needs you" count={merged.length} tone="needs-you" />
                {merged.map((item, i) => renderItem(item, i))}
              </section>
            ) : null}

            {inFlightCount > 0 ? (
              <section className="space-y-2">
                <AttentionHeader label="in flight" count={inFlightCount} tone="in-flight" />
                {inFlight.map((r) => (
                  <InFlightRow key={r.runId} run={r} />
                ))}
                {triagingRows.map((idea) => (
                  <TriagingRow key={idea.id} idea={idea} />
                ))}
              </section>
            ) : null}

            {unattended.length > 0 ? (
              <section className="space-y-2">
                <AttentionHeader
                  label="done while you were away"
                  count={unattended.length}
                  tone="unattended"
                  action={
                    <button
                      type="button"
                      disabled={acknowledgeAmbient.isPending}
                      onClick={() => acknowledgeAmbient.mutate(unattended.map((e) => e.id))}
                      className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] disabled:opacity-50"
                    >
                      clear
                    </button>
                  }
                />
                {unattended.map((e) => (
                  <UnattendedRow
                    key={e.id}
                    event={e}
                    onDismiss={() => acknowledgeAmbient.mutate([e.id])}
                    dismissing={acknowledgeAmbient.isPending}
                  />
                ))}
              </section>
            ) : null}
          </>
        ) : (
          merged.map((item, i) => renderItem(item, i))
        )}
      </div>

      {/* Desktop reading pane — the full detail for the open row, docked beside
          the list like a Gmail thread panel. Hidden on phone (clicks navigate
          to the full route there). */}
      <div className="hidden md:block md:sticky md:top-5 md:min-w-0">
        <InboxPane selected={selected} onResolved={() => setSelected(null)} />
      </div>
    </div>
  );
}

/**
 * The Gmail-style reading pane: renders the selected item's *actual* full
 * detail component (all data — the same one its route renders), not a truncated
 * preview. Keyed by id so switching rows remounts cleanly (fresh queries, no
 * carried-over draft/checkbox state). Empty until the operator picks a row.
 */
function InboxPane({
  selected,
  onResolved,
}: {
  selected: SelectedItem | null;
  onResolved: () => void;
}) {
  if (!selected) {
    return (
      <div className="surface flex flex-col items-center justify-center text-center px-6 py-16 min-h-[280px]">
        <div className="display text-[15px] text-[var(--color-fg-2)] mb-1.5">nothing selected</div>
        <p className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          pick a card on the left
        </p>
      </div>
    );
  }
  switch (selected.kind) {
    case "decision":
      return <DecisionDetail key={selected.id} id={selected.id} embedded onResolved={onResolved} />;
    case "plan":
      return <PlanDetail key={selected.id} id={selected.id} embedded onResolved={onResolved} />;
    case "feedback":
      return <FeedbackDetail key={selected.id} id={selected.id} embedded onResolved={onResolved} />;
    case "audit":
      return <AuditPane key={selected.id} auditId={selected.id} projectId={selected.projectId} />;
  }
}

/**
 * The watch strip — Heimdall's ambient presence above the inbox. Pairs with the
 * shell ticker but adds the eye glyph + the amber "needs you" count (the one
 * amber element this surface spends, since it points at decisions that are yours).
 */
function WatchStrip({
  running,
  queued,
  costToday,
  needYou,
}: {
  running: number;
  queued: number;
  costToday: number;
  needYou: number;
}) {
  const cost = costToday === 0 ? "$0" : costToday < 0.01 ? "<$0.01" : `$${costToday.toFixed(2)}`;
  return (
    <Link
      to="/ops"
      className="flex items-center gap-2.5 px-3 h-9 surface-2 mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-fg-2)] tabular-nums"
      aria-label="ops dashboard"
    >
      <HeimdallMark size={14} title="Heimdall" />
      {running > 0 ? (
        <span className="flex items-center gap-1.5 text-[var(--color-working)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-working)] pulse-dot" />
          {running} running
        </span>
      ) : (
        <span>idle</span>
      )}
      {queued > 0 ? <span>· {queued}q</span> : null}
      <span>· {cost} today</span>
      <span className="flex-1" />
      {needYou > 0 ? <span className="chip chip-accent">{needYou} need you</span> : null}
    </Link>
  );
}

/** A live run, mid-flight. Teal, breathing, with an indeterminate progress bar. */
function InFlightRow({ run }: { run: AmbientRun }) {
  const elapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
  const elapsedLabel =
    elapsed < 60
      ? `${elapsed}s`
      : elapsed < 3600
        ? `${Math.floor(elapsed / 60)}m`
        : `${Math.floor(elapsed / 3600)}h`;
  // The run pane lives under the project, not at a bare /runs/:id (which 404s).
  const href = run.projectId ? `/projects/${run.projectId}/runs/${run.runId}` : "/ops";
  return (
    <Link
      to={href}
      className="flex gap-3 surface drop-in breathe px-3.5 py-3 active:bg-[var(--color-bg-2)]"
    >
      {/* inset rounded accent rail — softer than a hard border-left */}
      <span className="w-[3px] rounded-[2px] bg-[var(--color-working)] shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-working)] pulse-dot" />
          <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-working)]">
            running
          </span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            · iter {run.iterationCount}
          </span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {elapsedLabel}
          </span>
        </div>
        <p className="text-[15px] text-[var(--color-fg-1)] leading-snug truncate mt-1.5">
          {run.projectName ?? run.projectSlug ?? "run"}
        </p>
        {/* indeterminate progress — the run is working, ETA unknown */}
        <div className="mt-2 h-[3px] rounded-full bg-[var(--color-working-soft)] overflow-hidden">
          <div className="h-full w-1/3 bg-[var(--color-working)] indeterminate" />
        </div>
        <p className="mono text-[10.5px] text-[var(--color-fg-3)] mt-2 truncate">
          {run.taskId ? `${run.taskId} · ` : ""}
          {run.agentName} · {run.runId.slice(0, 8)}
        </p>
      </div>
    </Link>
  );
}

const UNATTENDED_CHIP: Record<string, { label: string; icon: typeof GitMerge }> = {
  auto_merged: { label: "auto · merged", icon: GitMerge },
  auto_ran: { label: "auto · ran", icon: ArrowUpRight },
  trust_promoted: { label: "auto · promoted", icon: CheckCircle2 },
  milestone_auto_planned: { label: "auto · milestone", icon: ArrowUpRight },
};

/**
 * A thing the system did unattended while you were away. FYI only — no
 * approve/park verdict, just an acknowledge (the ✕) that clears it from the
 * digest. The event stays in the /ops history log regardless.
 */
function UnattendedRow({
  event,
  onDismiss,
  dismissing,
}: {
  event: AmbientEvent;
  onDismiss: () => void;
  dismissing?: boolean;
}) {
  const elapsed = Math.max(0, Math.floor((Date.now() - event.createdAt) / 1000));
  const ago =
    elapsed < 60
      ? `${elapsed}s`
      : elapsed < 3600
        ? `${Math.floor(elapsed / 60)}m`
        : elapsed < 86400
          ? `${Math.floor(elapsed / 3600)}h`
          : `${Math.floor(elapsed / 86400)}d`;
  const chip = UNATTENDED_CHIP[event.kind] ?? { label: `auto · ${event.kind}`, icon: ArrowUpRight };
  const Icon = chip.icon;
  // The run pane is nested under its project; a bare /runs/:id 404s. Fall back
  // to the project, then to /ops, as the ambient event loses its ids.
  const href =
    event.runId && event.projectId
      ? `/projects/${event.projectId}/runs/${event.runId}`
      : event.projectId
        ? `/projects/${event.projectId}`
        : "/ops";
  return (
    <div
      className="relative rounded-[10px] border active:bg-[var(--color-bg-2)]"
      style={{
        background: "var(--color-working-tint)",
        borderColor: "var(--color-working-tint-line)",
      }}
    >
      <Link to={href} className="block px-4 py-2.5 pr-10">
        <div className="flex items-center gap-2">
          <AutoChip>
            <Icon size={9} />
            {chip.label}
          </AutoChip>
          {event.projectName ? (
            <span className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
              {event.projectName}
            </span>
          ) : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">{ago} ago</span>
        </div>
        <p className="text-[13px] text-[var(--color-fg-2)] leading-snug mt-1 line-clamp-2">
          {event.message}
        </p>
      </Link>
      <button
        type="button"
        aria-label="dismiss"
        disabled={dismissing}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="absolute right-2 top-2 h-7 w-7 inline-flex items-center justify-center text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] disabled:opacity-50"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: InboxView; onChange: (v: InboxView) => void }) {
  const tabs: InboxView[] = ["active", "snoozed"];
  return (
    <div className="flex items-center gap-1.5">
      {tabs.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={
            view === v
              ? "chip text-[var(--color-fg-1)] border-[var(--color-line-bright)]"
              : "chip text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
          }
        >
          {v}
        </button>
      ))}
    </div>
  );
}

/** Rings the card whose detail is open in the desktop reading pane. No-op on
 *  phone widths, where there is no pane. */
function SelectableWrapper({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      className={
        active
          ? "md:ring-1 md:ring-[var(--color-line-bright)] md:rounded-sm md:transition"
          : "md:transition"
      }
    >
      {children}
    </div>
  );
}

function FeedbackCard({
  row,
  onOpen,
  snoozeControl,
}: {
  row: FeedbackInboxRow;
  onOpen: () => void;
  snoozeControl?: React.ReactNode;
}) {
  const elapsed = Math.max(0, Math.floor((Date.now() - row.createdAt) / 1000));
  const elapsedLabel =
    elapsed < 60
      ? `${elapsed}s`
      : elapsed < 3600
        ? `${Math.floor(elapsed / 60)}m`
        : `${Math.floor(elapsed / 3600)}h`;
  return (
    <div className="surface drop-in relative active:bg-[var(--color-bg-2)]">
      <Link
        to={`/feedback/${row.id}`}
        onClick={(e) => {
          // Route through onOpen so navigation stays consistent with the
          // other cards (which have no inner <Link>).
          e.preventDefault();
          onOpen();
        }}
        className="block px-4 py-3 pr-12"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="chip flex items-center gap-1.5">
            {row.vote === "up" ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
            feedback
          </span>
          {row.contextHint ? <span className="chip">{row.contextHint}</span> : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {elapsedLabel} ago
          </span>
        </div>
        <p className="text-[14px] leading-relaxed text-[var(--color-fg-1)] line-clamp-2">
          {row.body}
        </p>
      </Link>
      <div className="absolute right-3 top-3">{snoozeControl}</div>
    </div>
  );
}

function SnoozeControl({
  view,
  snoozedUntil,
  disabled,
  onSnooze,
}: {
  view: InboxView;
  snoozedUntil: number | null;
  disabled?: boolean;
  onSnooze: (snoozedUntil: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isSnoozed = view === "snoozed" || (snoozedUntil != null && snoozedUntil > Date.now());

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative" data-card-skip-open>
      <button
        type="button"
        aria-label={isSnoozed ? "change snooze" : "snooze"}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="h-7 w-7 inline-flex items-center justify-center text-[var(--color-fg-2)] hover:text-[var(--color-fg)] disabled:opacity-50"
      >
        <Clock size={15} />
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-20 surface-2 shadow-[var(--shadow-elev)] py-1 min-w-[176px] text-[13px]">
          {view === "snoozed" ? (
            <SnoozeMenuItem
              label="wake now"
              icon={<RotateCcw size={13} />}
              onClick={() => {
                onSnooze(null);
                setOpen(false);
              }}
            />
          ) : null}
          {SNOOZE_PRESETS.map((preset) => (
            <SnoozeMenuItem
              key={preset.label}
              label={preset.label}
              onClick={() => {
                onSnooze(Date.now() + preset.ms);
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SnoozeMenuItem({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-3)] flex items-center gap-2 text-[var(--color-fg-1)]"
    >
      {icon}
      {label}
    </button>
  );
}

function TriagingRow({ idea }: { idea: TriagingIdea }) {
  const elapsed = Math.max(0, Math.floor((Date.now() - idea.createdAt) / 1000));
  const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
  // Ideas mid-triage have no detail page yet — route to the ambient-activity
  // view (/ops) so the row taps somewhere real, matching the watch strip.
  return (
    <Link
      to="/ops"
      className="flex gap-3 surface drop-in px-3.5 py-3 active:bg-[var(--color-bg-2)]"
    >
      <span className="w-[3px] rounded-[2px] bg-[var(--color-working)] shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="chip chip-working flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-working)] pulse-dot" />
            triaging
          </span>
          {idea.intentRole ? <span className="chip">{idea.intentRole}</span> : null}
          {idea.intentCeremony ? <span className="chip">{idea.intentCeremony}</span> : null}
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {elapsedLabel} ago
          </span>
        </div>
        <p className="text-[14px] leading-relaxed text-[var(--color-fg-1)] line-clamp-3">
          {idea.rawText}
        </p>
      </div>
    </Link>
  );
}

function InboxSkeleton() {
  const slots = ["s1", "s2", "s3", "s4"] as const;
  return (
    <div className="space-y-2.5">
      {slots.map((id) => (
        <div key={id} className="surface p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="skel h-4 w-16" />
            <div className="skel h-4 w-12" />
            <div className="skel h-3 w-12 ml-auto" />
          </div>
          <div className="skel h-5 w-3/4 mb-2" />
          <div className="skel h-3.5 w-full mb-1.5" />
          <div className="skel h-3.5 w-5/6" />
        </div>
      ))}
    </div>
  );
}
