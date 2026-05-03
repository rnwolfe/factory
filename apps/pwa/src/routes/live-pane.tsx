import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getToken } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

interface TickerEvent {
  kind: string;
  iteration: number;
  text?: string;
  name?: string;
  argSummary?: string;
  sha?: string;
  subject?: string;
  exitCode?: number;
  ts?: number;
}

export function LivePane() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>();
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ticker, setTicker] = useState<TickerEvent[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [paneStatus, setPaneStatus] = useState<"connecting" | "open" | "closed">("connecting");

  const run = useQuery({
    queryKey: ["runs.get", runId],
    queryFn: () => trpc.runs.get.query({ id: runId }),
    enabled: runId.length > 0,
    refetchInterval: 3_000,
  });

  // Seed the ticker from persisted events so completed runs aren't blank.
  // Only runs once per mount — after that, the live WS feed is authoritative.
  const persistedEvents = useQuery({
    queryKey: ["runs.events", runId],
    queryFn: () => trpc.runs.events.query({ runId }),
    enabled: runId.length > 0 && !seeded,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!persistedEvents.data || seeded) return;
    // DB rows are asc by id; ticker renders newest-first, so reverse.
    const events = persistedEvents.data
      .map((row) => row.payload as unknown as TickerEvent)
      .reverse();
    setTicker(events);
    setSeeded(true);
  }, [persistedEvents.data, seeded]);

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
        black: "#0a0908",
        brightBlack: "#5b554d",
        white: "#e8e3d8",
        brightWhite: "#fbf6ec",
        red: "#d36a6a",
        brightRed: "#e58383",
        green: "#82bb87",
        brightGreen: "#9ed6a0",
        yellow: "#dcb35c",
        brightYellow: "#ecc572",
        blue: "#7d9bd6",
        brightBlue: "#a3b9e6",
        magenta: "#ad7fbf",
        brightMagenta: "#c298d4",
        cyan: "#6db4b8",
        brightCyan: "#8acdd1",
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
    fitRef.current = fit;

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
      fitRef.current = null;
    };
  }, []);

  // Pane WS — raw bytes from tmux.
  useEffect(() => {
    if (!runId) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/pane?runId=${encodeURIComponent(runId)}&token=${encodeURIComponent(token)}`;
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
  }, [runId]);

  // Events WS — structured event ticker.
  useEffect(() => {
    if (!runId) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/events?runId=${encodeURIComponent(runId)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        setTicker((cur) => [data, ...cur].slice(0, 500));
        if (data.kind === "iteration_end" || data.kind === "agent_exit") {
          qc.invalidateQueries({ queryKey: ["runs.get", runId] });
          qc.invalidateQueries({ queryKey: ["runs.list", id] });
          qc.invalidateQueries({ queryKey: ["projects.get", id] });
        }
      } catch {
        // ignore
      }
    };
    return () => {
      ws.close();
    };
  }, [runId, qc, id]);

  const abort = async () => {
    try {
      await trpc.runs.abort.mutate({ id: runId });
    } catch {
      // ignore
    }
    qc.invalidateQueries({ queryKey: ["runs.get", runId] });
  };

  const status = run.data?.status ?? "queued";
  const elapsed = run.data
    ? Math.max(0, Math.floor(((run.data.endedAt ?? Date.now()) - run.data.startedAt) / 1000))
    : 0;

  return (
    <div
      className="flex flex-col"
      style={{
        minHeight:
          "calc(100vh - 56px - 72px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
      }}
    >
      <div className="surface p-3 mb-2">
        <div className="flex items-center justify-between gap-2">
          <Link
            to={`/projects/${id}`}
            className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
          >
            <ArrowLeft size={11} /> back
          </Link>
          <div className="flex items-center gap-2">
            <span className={`chip ${chipForStatus(status)}`}>{status}</span>
            <span className="chip">{paneStatus}</span>
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
              {fmtElapsed(elapsed)} · iter {run.data?.iterationCount ?? 0}
            </span>
          </div>
        </div>
        <div className="mono text-[11px] text-[var(--color-fg-3)] mt-2 truncate">
          run {runId.slice(0, 12)} · task {run.data?.taskId ?? "ad-hoc"}
        </div>
      </div>

      <div className="surface p-0 overflow-hidden flex-1 min-h-[280px]">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <div className="surface mt-2 p-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b border-[var(--color-line)] mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          events ({ticker.length})
        </div>
        <ul className="divide-y divide-[var(--color-line)] max-h-[420px] overflow-y-auto">
          {ticker.length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">waiting for events…</li>
          ) : (
            ticker.map((e, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: ticker is append-only with no stable id
                key={`${e.kind}-${e.ts ?? 0}-${i}`}
                className="px-3 py-1.5 mono text-[11.5px] flex gap-2"
              >
                <span className="text-[var(--color-fg-3)] tabular-nums w-12 shrink-0">
                  i{e.iteration}
                </span>
                <span className="text-[var(--color-accent)] w-24 shrink-0">{e.kind}</span>
                <span className="text-[var(--color-fg-1)] truncate">{tickerLabel(e)}</span>
              </li>
            ))
          )}
        </ul>
      </div>

      {(status === "running" || status === "queued") && (
        <button type="button" onClick={abort} className="btn btn-danger w-full mt-2">
          <Square size={14} /> abort run
        </button>
      )}
    </div>
  );
}

function chipForStatus(s: string): string {
  if (s === "completed") return "chip-greenlit";
  if (s === "running") return "chip-accent";
  if (s === "failed" || s === "aborted") return "chip-trashed";
  return "";
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function tickerLabel(e: TickerEvent): string {
  switch (e.kind) {
    case "text":
      return (e.text ?? "").slice(0, 80);
    case "tool":
      return `${e.name ?? ""} · ${e.argSummary ?? ""}`.slice(0, 80);
    case "session":
      return "session captured";
    case "commit":
      return `${(e.sha ?? "").slice(0, 8)} ${e.subject ?? ""}`.slice(0, 80);
    case "iteration_start":
    case "iteration_end":
      return `iteration ${e.iteration} ${e.kind === "iteration_end" ? `(exit ${e.exitCode ?? "?"})` : ""}`;
    case "agent_exit":
      return `agent exited ${e.exitCode ?? "?"}`;
    default:
      return "";
  }
}
