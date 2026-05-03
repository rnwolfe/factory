import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { DecisionCard, type DecisionRow } from "../components/decision-card.tsx";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

export function Inbox() {
  const qc = useQueryClient();

  const inbox = useQuery({
    queryKey: ["decisions.inbox"],
    queryFn: () => trpc.decisions.inbox.query() as unknown as Promise<DecisionRow[]>,
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
        qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
    },
  });

  if (inbox.isLoading) return <InboxSkeleton />;
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

  const rows = inbox.data ?? [];
  const ideasById = new Map(ideasList.data?.map((i) => [i.id, i.rawText]) ?? []);

  if (rows.length === 0) {
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
      {rows.map((d, i) => (
        <DecisionCard
          key={d.id}
          decision={d}
          ideaText={d.ideaId ? (ideasById.get(d.ideaId) ?? null) : null}
          index={i}
          onAction={(a) => action.mutate({ decisionId: d.id, action: a })}
          onOpen={() => {
            // detail sheet: M5 keeps it inline; M6 may add a dedicated route.
            const message = JSON.stringify(d.payload, null, 2);
            alert(message.slice(0, 4000));
          }}
        />
      ))}
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
