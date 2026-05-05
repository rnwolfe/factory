import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

interface SessionRow {
  id: string;
  projectId: string;
  status: "running" | "ended" | "merged" | "merge_failed" | "aborted";
  mode: "claude" | "shell";
  description: string | null;
  branchName: string;
  worktreePath: string;
  startedAt: number;
  endedAt: number | null;
  commitCount: number;
  mergedAt: number | null;
  mergeError: string | null;
}

function chipClass(status: SessionRow["status"]): string {
  if (status === "running") return "status-in_progress";
  if (status === "merged") return "chip-greenlit";
  if (status === "merge_failed") return "chip-trashed";
  return "";
}

export function SessionPane() {
  const { id = "", sessionId = "" } = useParams<{ id: string; sessionId: string }>();
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [paneStatus, setPaneStatus] = useState<"connecting" | "open" | "closed">("connecting");

  const session = useQuery({
    queryKey: ["sessions.get", sessionId],
    queryFn: () =>
      trpc.sessions.get.query({ id: sessionId }) as unknown as Promise<SessionRow | null>,
    enabled: sessionId.length > 0,
    refetchInterval: 4_000,
  });

  // Boot the terminal once.
  useEffect(() => {
    if (!containerRef.current) return;
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
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Subscribe to /ws/pane using the sessionId as the carrier (sessions
  // reuse the pane channel; cuid namespace is shared with runs).
  useEffect(() => {
    if (!sessionId) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/pane?runId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
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
    // Forward operator keystrokes to the daemon, which routes them to tmux
    // send-keys for the underlying claude/shell process. xterm.js gives us
    // raw byte strings (already encoded for the terminal protocol).
    const term = termRef.current;
    const dataDisposer = term?.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    return () => {
      dataDisposer?.dispose();
      ws.close();
    };
  }, [sessionId]);

  const end = useMutation({
    mutationFn: () => trpc.sessions.end.mutate({ id: sessionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions.get", sessionId] });
      qc.invalidateQueries({ queryKey: ["sessions.list", id] });
    },
  });

  const abort = useMutation({
    mutationFn: () => trpc.sessions.abort.mutate({ id: sessionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions.get", sessionId] });
      qc.invalidateQueries({ queryKey: ["sessions.list", id] });
    },
  });

  const s = session.data;

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-[var(--color-line)] px-3 py-2.5 flex items-center gap-2 flex-wrap">
        <Link
          to={`/projects/${id}`}
          className="mono text-[11px] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] flex items-center gap-1"
        >
          <ArrowLeft size={11} /> project
        </Link>
        <span className="mono text-[12px] text-[var(--color-fg-1)] truncate flex-1">
          {s?.description || s?.branchName.replace(/^factory\/adhoc-/, "") || sessionId.slice(0, 8)}
        </span>
        {s ? <span className={`chip ${chipClass(s.status)}`}>{s.status}</span> : null}
        {s?.status === "running" ? (
          <>
            <button
              type="button"
              onClick={() => end.mutate()}
              disabled={end.isPending}
              className="btn btn-ghost text-[11px] !h-7 !px-2"
              title="end session — try-merge into main"
            >
              <Square size={11} /> end
            </button>
            <button
              type="button"
              onClick={() => abort.mutate()}
              disabled={abort.isPending}
              className="btn btn-ghost text-[11px] !h-7 !px-2"
              title="abort session — kill without merging"
            >
              <X size={11} /> abort
            </button>
          </>
        ) : null}
      </header>

      {s && s.status === "merge_failed" ? (
        <div className="border-b border-[var(--color-line)] px-3 py-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          merge failed: {s.mergeError ?? "(unknown reason)"}
          {" — "}
          <Link to={`/`} className="underline">
            check inbox for merge_failure decision
          </Link>
        </div>
      ) : null}

      <div className="px-3 py-1 mono text-[10.5px] text-[var(--color-fg-3)] flex items-center gap-2 flex-wrap">
        <span>ws: {paneStatus}</span>
        {s ? (
          <>
            <span>· branch {s.branchName}</span>
            <span>
              · {s.commitCount} commit{s.commitCount === 1 ? "" : "s"}
            </span>
          </>
        ) : null}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 px-3 pb-3 bg-[#0d0c0a]" />
    </div>
  );
}
