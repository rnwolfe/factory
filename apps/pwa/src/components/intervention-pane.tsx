import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";
import { wireXtermTouchScroll } from "../lib/xterm-touch.ts";

interface InterventionRow {
  id: string;
  decisionId: string;
  decisionKind: "blocked_run" | "merge_failure";
  worktreePath: string;
  tmuxSessionName: string;
  status: "active" | "resumed" | "cancelled" | "orphaned";
  startedAt: number;
  endedAt: number | null;
}

interface InterventionTail {
  content: string;
  offset: number;
  size: number;
  truncated: boolean;
}

/**
 * Operator-facing tmux pane for an active intervention. Modeled on
 * SessionPane (apps/pwa/src/routes/session-pane.tsx): xterm terminal,
 * /ws/pane subscription using the intervention id as carrier, prior-
 * scrollback tail replay so reloads don't lose context, keystrokes
 * routed via wsRef so terminal lifetime is decoupled from WS reconnects.
 *
 * On "resume agent" (blocked_run) → daemon submits a new run with
 * --resume <sessionId>; we navigate to the new run's pane. On "resume
 * merge" (merge_failure) → daemon retries mergeIntoMain; we land back
 * on the project. "cancel" tears down the tmux without running the
 * resume action.
 */
export function InterventionPane({
  intervention,
  projectId,
}: {
  intervention: InterventionRow;
  projectId: string | null;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const replayedRef = useRef(false);
  const [paneStatus, setPaneStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [resumeError, setResumeError] = useState<string | null>(null);

  const tail = useQuery({
    queryKey: ["interventions.tail", intervention.id],
    queryFn: () =>
      trpc.interventions.tail.query({
        id: intervention.id,
      }) as unknown as Promise<InterventionTail>,
    enabled: intervention.id.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "underline",
      fontFamily: "Geist Mono, ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      theme: {
        background: "#0d0c0a",
        foreground: "#e8e3d8",
        cursor: "#f08a3d",
        selectionBackground: "#3a322a",
      },
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    const dataDisposer = term.onData((d) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
    });

    term.focus();
    const onMouseDown = (e: MouseEvent) => {
      if ((e as MouseEvent & { pointerType?: string }).pointerType === "touch") return;
      term.focus();
    };
    container.addEventListener("mousedown", onMouseDown);
    const detachTouch = wireXtermTouchScroll(term, container);

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      container.removeEventListener("mousedown", onMouseDown);
      detachTouch();
      dataDisposer.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (replayedRef.current) return;
    const term = termRef.current;
    const data = tail.data;
    if (!term || !data) return;
    if (data.content.length > 0) {
      term.write(data.content);
    }
    replayedRef.current = true;
  }, [tail.data]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/pane?runId=${encodeURIComponent(intervention.id)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => setPaneStatus("open");
    ws.onclose = () => setPaneStatus("closed");
    ws.onerror = () => setPaneStatus("closed");
    ws.onmessage = (ev) => {
      const term = termRef.current;
      if (!term) return;
      if (typeof ev.data === "string") {
        term.write(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
      }
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [intervention.id]);

  const resume = useMutation({
    mutationFn: () => trpc.interventions.resume.mutate({ id: intervention.id }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["interventions.forDecision", intervention.decisionId] });
      qc.invalidateQueries({ queryKey: ["decisions.get", intervention.decisionId] });
      qc.invalidateQueries({ queryKey: ["decisions.inbox"] });
      const newRunId = (res as { newRunId?: string | null }).newRunId;
      if (newRunId && projectId) {
        nav(`/projects/${projectId}/runs/${newRunId}`);
      } else if (projectId) {
        nav(`/projects/${projectId}`);
      } else {
        nav("/");
      }
    },
    onError: (err) => {
      setResumeError(err instanceof Error ? err.message : String(err));
    },
  });

  const cancel = useMutation({
    mutationFn: () => trpc.interventions.cancel.mutate({ id: intervention.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["interventions.forDecision", intervention.decisionId] });
    },
  });

  const resumeLabel = intervention.decisionKind === "blocked_run" ? "resume agent" : "retry merge";

  return (
    <div className="surface overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--color-line)] flex items-center gap-2 flex-wrap">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          intervention
        </span>
        <span className="chip">
          {intervention.decisionKind === "blocked_run" ? "over run worktree" : "over project main"}
        </span>
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
          ws: {paneStatus} · {intervention.worktreePath}
        </span>
      </div>

      <div ref={containerRef} className="h-[420px] bg-[#0d0c0a]" />

      <div className="px-3 py-2 border-t border-[var(--color-line)] flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => resume.mutate()}
          disabled={resume.isPending}
        >
          <Play size={12} /> {resume.isPending ? "resuming…" : resumeLabel}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
        >
          <X size={12} /> {cancel.isPending ? "cancelling…" : "cancel"}
        </button>
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
          {intervention.decisionKind === "blocked_run"
            ? "resume → auto-commit dirty work + new run with --resume <sessionId>"
            : "retry merge → re-run mergeIntoMain on this branch"}
        </span>
      </div>

      {resumeError ? (
        <div className="px-3 py-2 mono text-[11px] text-[var(--color-verdict-trashed)] border-t border-[var(--color-line)]">
          {resumeError}
        </div>
      ) : null}
    </div>
  );
}
