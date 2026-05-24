import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, ExternalLink, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";
import { wireXtermPaste } from "../lib/xterm-paste.ts";
import { wireXtermTouchScroll } from "../lib/xterm-touch.ts";

interface RunningScript {
  id: string;
  projectId: string;
  scriptName: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed" | "failed";
  urls: string[];
  tail: string;
}

export function ScriptPane() {
  const { id = "", scriptId = "" } = useParams<{ id: string; scriptId: string }>();
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const replayedRef = useRef(false);
  const [paneStatus, setPaneStatus] = useState<"connecting" | "open" | "closed">("connecting");

  const handle = useQuery({
    queryKey: ["scripts.get", scriptId],
    queryFn: () =>
      trpc.scripts.get.query({ id: scriptId }) as unknown as Promise<RunningScript | null>,
    enabled: scriptId.length > 0,
    refetchInterval: 4_000,
  });

  // Boot the terminal once.
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
    fitRef.current = fit;

    const detachTouch = wireXtermTouchScroll(term, container);
    const detachPaste = wireXtermPaste(term, container);

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
      detachTouch();
      detachPaste();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Replay tail (last 32KB) once on mount so revisiting shows context before live bytes arrive.
  useEffect(() => {
    if (!handle.data || replayedRef.current) return;
    const term = termRef.current;
    if (!term) return;
    if (handle.data.tail.length > 0) {
      term.write(handle.data.tail);
    }
    replayedRef.current = true;
  }, [handle.data]);

  // Live byte stream over /ws/script.
  useEffect(() => {
    if (!scriptId) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/script?scriptId=${encodeURIComponent(scriptId)}&token=${encodeURIComponent(token)}`;
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
    return () => {
      ws.close();
    };
  }, [scriptId]);

  const stop = useMutation({
    mutationFn: () => trpc.scripts.stop.mutate({ id: scriptId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scripts.get", scriptId] });
      qc.invalidateQueries({ queryKey: ["scripts.active", id] });
    },
  });

  const h = handle.data;

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-[var(--color-line)] px-3 py-2.5 flex items-center gap-2">
        <Link
          to={`/projects/${id}`}
          className="mono text-[11px] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)] flex items-center gap-1"
        >
          <ArrowLeft size={11} /> project
        </Link>
        <span className="mono text-[12px] text-[var(--color-fg-1)] truncate flex-1">
          {h ? h.scriptName : scriptId.slice(0, 8)}
        </span>
        {h ? (
          <span
            className={`chip ${
              h.status === "running"
                ? "status-in_progress"
                : h.exitCode === 0
                  ? "chip-greenlit"
                  : "chip-trashed"
            }`}
          >
            {h.status}
            {h.exitCode != null ? ` ${h.exitCode}` : ""}
          </span>
        ) : null}
        {h?.status === "running" ? (
          <button
            type="button"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            className="btn btn-ghost text-[11px] !h-7 !px-2"
            aria-label="stop script"
          >
            <Square size={11} /> stop
          </button>
        ) : null}
      </header>

      {h && h.urls.length > 0 ? (
        <div className="border-b border-[var(--color-line)] px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            urls
          </span>
          {h.urls.map((u) => (
            <a
              key={u}
              href={u}
              target="_blank"
              rel="noreferrer noopener"
              className="chip flex items-center gap-1"
            >
              <ExternalLink size={10} />
              <span className="mono text-[11px]">{u}</span>
            </a>
          ))}
        </div>
      ) : null}

      <div className="px-3 py-1 mono text-[10.5px] text-[var(--color-fg-3)] flex items-center gap-2">
        <span>ws: {paneStatus}</span>
        {h ? <span>· {h.command}</span> : null}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 px-3 pb-3 bg-[#0d0c0a]" />
    </div>
  );
}
