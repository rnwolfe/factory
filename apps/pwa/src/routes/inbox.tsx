import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuditCard, type AuditRow } from "../components/audit-card.tsx";
import { DecisionCard, type DecisionRow } from "../components/decision-card.tsx";
import { PlanCard, type PlanRow } from "../components/plan-card.tsx";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

interface TriagingIdea {
  id: string;
  rawText: string;
  goalHint: string | null;
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
  | { kind: "audit"; row: AuditRow };

export function Inbox() {
  const qc = useQueryClient();
  const nav = useNavigate();

  const inbox = useQuery({
    queryKey: ["decisions.inbox"],
    queryFn: () => trpc.decisions.inbox.query() as unknown as Promise<DecisionRow[]>,
    refetchInterval: 6_000,
  });

  const planInbox = useQuery({
    queryKey: ["plans.inbox"],
    queryFn: () => trpc.plans.inbox.query() as unknown as Promise<PlanRow[]>,
    refetchInterval: 6_000,
  });

  const auditInbox = useQuery({
    queryKey: ["audits.inbox"],
    queryFn: () => trpc.audits.inbox.query() as unknown as Promise<AuditRow[]>,
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

  // Live push: subscribe to /ws/inbox for instant updates.
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/inbox?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
      ws.onmessage = () => {
        // Coarse invalidation — inbox + plan inbox + triaging + audit inbox
        // all refetch on any inbox-channel event. Set is small and queries
        // are cheap.
        qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
        qc.invalidateQueries({ queryKey: ["plans.inbox"] });
        qc.invalidateQueries({ queryKey: ["audits.inbox"] });
        qc.invalidateQueries({ queryKey: ["ideas.triaging"] });
      };
    } catch {
      // ignore — polling still covers us
    }
    return () => {
      ws?.close();
    };
  }, [qc]);

  const action = useMutation({
    mutationFn: (vars: {
      decisionId: string;
      action: "approve" | "park" | "trash" | "decompose" | "dismiss";
    }) => trpc.decisions.action.mutate(vars),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["decisions.inbox"] });
      const prev = qc.getQueryData<DecisionRow[]>(["decisions.inbox"]);
      qc.setQueryData<DecisionRow[]>(["decisions.inbox"], (rows) =>
        (rows ?? []).filter((r) => r.id !== vars.decisionId),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["decisions.inbox"], ctx.prev);
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

  const triagingRows = triaging.data ?? [];

  if (inbox.isLoading && triagingRows.length === 0 && !planInbox.data) {
    return <InboxSkeleton />;
  }
  if (inbox.isError) {
    return (
      <div className="surface p-4 text-sm">
        <div className="display text-[var(--color-verdict-trashed)] mb-2">
          something is wrong with your factory.
        </div>
        <div className="text-[var(--color-fg-2)]">{(inbox.error as Error).message}</div>
      </div>
    );
  }

  const decisionRows = inbox.data ?? [];
  const planRows = planInbox.data ?? [];
  const auditRows = auditInbox.data ?? [];
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
  ]
    .sort((a, b) => b.ts - a.ts)
    .map(({ ts: _ts, ...rest }) => rest as InboxItem);

  if (merged.length === 0 && triagingRows.length === 0) {
    return (
      <div className="px-2 pt-8">
        <div className="text-center">
          <div className="display text-2xl text-[var(--color-fg)] mb-2">no decisions</div>
          <p className="text-[var(--color-fg-2)] text-sm leading-relaxed mb-6">
            the inbox is empty. capture an idea — the factory triages within ~2 min.
          </p>
          <Link to="/inbox/new" className="btn btn-primary">
            <Plus size={16} /> new idea
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {triagingRows.map((idea) => (
        <TriagingRow key={idea.id} idea={idea} />
      ))}
      {merged.map((item, i) => {
        if (item.kind === "decision") {
          const d = item.row;
          return (
            <DecisionCard
              key={d.id}
              decision={d}
              ideaText={d.ideaId ? (ideasById.get(d.ideaId) ?? null) : null}
              index={i}
              onAction={(a) => action.mutate({ decisionId: d.id, action: a })}
              onOpen={() => nav(`/decisions/${d.id}`)}
            />
          );
        }
        if (item.kind === "plan") {
          const p = item.row;
          return <PlanCard key={p.id} plan={p} index={i} onOpen={() => nav(`/plans/${p.id}`)} />;
        }
        const a = item.row;
        return (
          <AuditCard
            key={a.id}
            audit={a}
            projectName={projectNameById.get(a.projectId) ?? null}
            index={i}
            onOpen={() => nav(`/projects/${a.projectId}/audits/${a.id}`)}
          />
        );
      })}
    </div>
  );
}

function TriagingRow({ idea }: { idea: TriagingIdea }) {
  const elapsed = Math.max(0, Math.floor((Date.now() - idea.createdAt) / 1000));
  const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
  return (
    <div className="surface drop-in px-4 py-3 border-l-2 border-[var(--color-accent)]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="chip chip-accent flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
          triaging
        </span>
        {idea.goalHint ? <span className="chip">goal {idea.goalHint}</span> : null}
        <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
          {elapsedLabel} ago
        </span>
      </div>
      <p className="text-[14px] leading-relaxed text-[var(--color-fg-1)] line-clamp-3">
        {idea.rawText}
      </p>
    </div>
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
