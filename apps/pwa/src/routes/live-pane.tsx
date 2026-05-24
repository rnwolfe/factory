import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, Hourglass, ListTree, Pencil, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { QualityReportPanel, type QualityReportView } from "../components/quality-report.tsx";
import { RunEventStream } from "../components/run-event-stream.tsx";
import { getToken } from "../lib/auth.ts";
import { useRunChannel } from "../lib/channels.ts";
import { trpc } from "../lib/trpc.ts";
import { wireXtermPaste } from "../lib/xterm-paste.ts";
import { wireXtermTouchScroll } from "../lib/xterm-touch.ts";

interface RunDiff {
  base: string | null;
  branch: string;
  files: Array<{ path: string; additions: number; deletions: number; renamed: boolean }>;
  totalAdditions: number;
  totalDeletions: number;
  commits: Array<{ sha: string; subject: string; ts: number; author: string }>;
}

const MAX_RAW_LOG_BYTES = 256 * 1024;

export function LivePane() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>();
  const qc = useQueryClient();
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The pane WS and the xterm instance boot on independent effects (WS keys
  // off run status; xterm boots lazily when the operator switches to raw).
  // These refs let either side push the latest grid dims into the other
  // when whichever one comes up second arrives — without rerunning the
  // effect that owns it.
  const paneWsRef = useRef<WebSocket | null>(null);
  const sendResizeRef = useRef<(() => void) | null>(null);
  const [paneStatus, setPaneStatus] = useState<"connecting" | "open" | "closed">("connecting");
  /**
   * "structured" (default) shows the parsed event timeline (`RunEventStream`).
   * "raw" shows the xterm dump of pane bytes — useful for debugging when the
   * structured view drops something. Operator preference is sticky per browser.
   */
  const [view, setView] = useState<"structured" | "raw">(() => {
    if (typeof window === "undefined") return "structured";
    return window.localStorage.getItem("livePane.view") === "raw" ? "raw" : "structured";
  });
  // Bytes already written to xterm from the persisted log. The pane WS only
  // delivers new bytes after subscription, so without this we'd duplicate any
  // overlap when both sources land on the screen.
  const replayedRef = useRef(false);

  const run = useQuery({
    queryKey: ["runs.get", runId],
    queryFn: () => trpc.runs.get.query({ id: runId }),
    enabled: runId.length > 0,
    refetchInterval: 30_000,
  });

  const diff = useQuery({
    queryKey: ["runs.diff", runId],
    queryFn: () => trpc.runs.diff.query({ runId }) as unknown as Promise<RunDiff>,
    enabled: runId.length > 0,
    refetchInterval: (query) => {
      // Once the run is settled, the diff doesn't change. Stop polling then.
      const status = query.state.data?.commits?.length != null ? "settled" : "running";
      return status === "settled" ? false : 5_000;
    },
  });

  // Replay the persisted tmux log on first switch to raw view. Lazy with
  // the terminal — fetches and replays only when the operator opens raw,
  // not on every page mount (saves a 256KB query and a multi-thousand-line
  // xterm write on every run-page navigation).
  const rawLog = useQuery({
    queryKey: ["runs.rawLog", runId],
    queryFn: () => trpc.runs.rawLog.query({ runId }),
    enabled: runId.length > 0 && view === "raw" && !replayedRef.current,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (view !== "raw") return;
    if (!rawLog.data || replayedRef.current) return;
    const term = termRef.current;
    if (!term) return;
    if (rawLog.data.truncated) {
      term.write(
        `\x1b[2m[truncated — showing last ${Math.round(MAX_RAW_LOG_BYTES / 1024)}KB of log]\x1b[22m\r\n`,
      );
    }
    if (rawLog.data.content.length > 0) {
      for (const line of rawLog.data.content.split("\n")) {
        term.write(`${line}\r\n`);
      }
    }
    replayedRef.current = true;
  }, [rawLog.data, view]);

  // Boot the terminal lazily — only once the operator switches to the raw
  // view. Mounting xterm eagerly (on every LivePane mount, even for users
  // who never toggle to raw) burns ~50–150ms of synchronous DOM construction
  // on every navigation into a run page. The structured view is the default
  // and covers 95% of operator needs.
  useEffect(() => {
    if (view !== "raw") return;
    if (!containerRef.current) return;
    if (termRef.current) return; // already booted from a prior toggle
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
    if (!containerRef.current) return;
    const container = containerRef.current;
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const detachTouch = wireXtermTouchScroll(term, container);
    const detachPaste = wireXtermPaste(term, container);

    // Push current grid dims to the daemon so tmux resize-windows the pane
    // and the inner program (claude, neovim, etc.) gets SIGWINCH with the
    // right $LINES/$COLUMNS. No-op if the WS isn't open yet — the WS effect
    // calls this again from its onopen handler to resync.
    const sendResize = () => {
      const ws = paneWsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const cols = term.cols;
      const rows = term.rows;
      if (cols < 2 || rows < 2) return;
      try {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      } catch {
        // ignore — next fit() will retry
      }
    };
    sendResizeRef.current = sendResize;
    const resizeDisposer = term.onResize(() => sendResize());
    sendResize();

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);
    // iOS Safari sometimes settles layout after `orientationchange` fires
    // and only later emits a `resize` event; wiring both makes rotation
    // reliably trigger fit() before the user sees a stale grid.
    window.addEventListener("orientationchange", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      ro.disconnect();
      resizeDisposer.dispose();
      sendResizeRef.current = null;
      detachTouch();
      detachPaste();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [view]);

  const runStatus = run.data?.status;

  // Pane WS — raw bytes from tmux. Forwards xterm.js keystrokes back as the
  // operator types so they can drive the underlying claude session.
  //
  // Only opened for runs that have a live tmux pane: `running` or `queued`
  // (queued runs may start at any moment and the WS preempts them). For
  // terminal states (completed/failed/aborted) there's no pane to attach
  // to; opening would just sit idle until the browser closed it as a
  // "closed" state, which is misleading.
  const shouldConnectPane = runStatus === "running" || runStatus === "queued";
  useEffect(() => {
    if (!runId) return;
    if (!shouldConnectPane) {
      setPaneStatus("closed");
      return;
    }
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/pane?runId=${encodeURIComponent(runId)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      paneWsRef.current = ws;
      setPaneStatus("open");
      // Resync the pane dims as soon as the channel is up. The xterm
      // instance may have fit itself well before this connect (e.g. the
      // operator was already in raw view) — without this, tmux would
      // stay at its 80x24 spawn default until the next browser resize.
      sendResizeRef.current?.();
    };
    ws.onclose = () => {
      if (paneWsRef.current === ws) paneWsRef.current = null;
      setPaneStatus("closed");
    };
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
    const term = termRef.current;
    // Encode to bytes so the daemon can tell keystrokes (binary frames)
    // apart from JSON control envelopes (text frames) without resorting
    // to a sentinel prefix on every keypress.
    const dataDisposer = term?.onData((d) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(new TextEncoder().encode(d));
    });
    return () => {
      dataDisposer?.dispose();
      if (paneWsRef.current === ws) paneWsRef.current = null;
      ws.close();
    };
  }, [runId, shouldConnectPane]);

  // Per-route invalidations: runs.get / runs.list / projects.get refetch on
  // any event matching this run. The structured stream (RunEventStream)
  // additionally handles its own UI updates via the same scoped channel.
  // `deferredTasks.forRun` is folded in so deferred_task_* events refresh
  // the panel immediately, instead of waiting for the 5s poll interval.
  useRunChannel(runId || null, [
    ["runs.get", runId],
    ["runs.list", id],
    ["projects.get", id],
    ["deferredTasks.forRun", runId],
  ]);

  const abort = async () => {
    try {
      await trpc.runs.abort.mutate({ id: runId });
    } catch {
      // ignore
    }
    qc.invalidateQueries({ queryKey: ["runs.get", runId] });
  };

  const startRefinement = useMutation({
    mutationFn: () => {
      if (!run.data?.taskId) throw new Error("ad-hoc runs cannot be refined");
      return trpc.plans.startRefinement.mutate({
        projectId: id,
        taskId: run.data.taskId,
        runId,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["plans.inbox"] });
      qc.invalidateQueries({ queryKey: ["plans.list", id] });
      nav(`/plans/${res.planId}`);
    },
  });

  const status = run.data?.status ?? "queued";
  const elapsed = run.data
    ? Math.max(0, Math.floor(((run.data.endedAt ?? Date.now()) - run.data.startedAt) / 1000))
    : 0;

  const qualityReport = useMemo<QualityReportView | null>(() => {
    if (!run.data?.qualityReport) return null;
    try {
      return JSON.parse(run.data.qualityReport) as QualityReportView;
    } catch {
      return null;
    }
  }, [run.data?.qualityReport]);

  const acceptanceResults = useMemo<AcceptanceResultView[] | null>(() => {
    if (!run.data?.acceptanceResults) return null;
    try {
      const parsed = JSON.parse(run.data.acceptanceResults) as AcceptanceResultView[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [run.data?.acceptanceResults]);

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
        <div className="mt-2 flex items-center gap-2">
          <div className="mono text-[11px] text-[var(--color-fg-3)] truncate flex-1 min-w-0">
            run {runId.slice(0, 12)} · task {run.data?.taskId ?? "ad-hoc"}
          </div>
          {run.data?.taskPlanId ? (
            <Link
              to={`/plans/${run.data.taskPlanId}`}
              className="chip chip-decompose flex items-center gap-1"
              title="this run was prompted with a frozen task plan"
            >
              <ListTree size={11} /> plan
            </Link>
          ) : null}
          {status === "running" || status === "queued" ? (
            <button
              type="button"
              onClick={abort}
              className="btn btn-danger !h-7 !px-2 text-[11px] shrink-0"
              aria-label="abort run"
            >
              <Square size={11} /> abort
            </button>
          ) : null}
        </div>
      </div>

      {run.data?.summary ? (
        <div className="surface mb-2 px-3 py-2.5">
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1">
            summary
          </div>
          <p className="text-[14px] leading-relaxed text-[var(--color-fg)] whitespace-pre-wrap">
            {run.data.summary}
          </p>
        </div>
      ) : null}

      {status === "blocked" && run.data?.blockerQuestions ? (
        <BlockerPanel rawQuestions={run.data.blockerQuestions} />
      ) : null}

      {acceptanceResults && acceptanceResults.length > 0 ? (
        <AcceptancePanel results={acceptanceResults} />
      ) : null}

      {status === "deferred" ? <DeferredTaskPanel runId={runId} /> : null}

      {qualityReport || run.data?.status === "completed" ? (
        <QualityReportPanel report={qualityReport} />
      ) : null}

      <div className="flex items-center gap-2 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          run log
        </span>
        <div className="hairline flex-1" />
        <button
          type="button"
          className={`mono text-[10.5px] uppercase tracking-[0.18em] px-2 py-1 rounded-[2px] ${
            view === "raw"
              ? "text-[var(--color-accent)] bg-[var(--color-accent-soft)]"
              : "text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
          }`}
          onClick={() => {
            const next = view === "raw" ? "structured" : "raw";
            setView(next);
            try {
              window.localStorage.setItem("livePane.view", next);
            } catch {
              // localStorage may be denied; the toggle still works for the session
            }
          }}
        >
          [{view === "raw" ? "rendered" : "raw"}]
        </button>
      </div>

      {/* Both views stay mounted — keeps xterm scrollback when toggling. */}
      <div className={view === "structured" ? "block" : "hidden"}>
        <RunEventStream runId={runId} />
      </div>
      <div
        className={`surface p-0 overflow-hidden ${view === "raw" ? "block flex-1 min-h-[280px]" : "hidden"}`}
      >
        <div ref={containerRef} className="h-full w-full min-h-[280px]" />
      </div>

      {diff.data ? <DiffPanel diff={diff.data} /> : null}

      {status === "running" || status === "queued" ? (
        <button type="button" onClick={abort} className="btn btn-danger w-full mt-2">
          <Square size={14} /> abort run
        </button>
      ) : run.data?.taskId &&
        (status === "completed" || status === "failed" || status === "blocked") ? (
        <button
          type="button"
          onClick={() => startRefinement.mutate()}
          disabled={startRefinement.isPending}
          className="btn w-full mt-2"
        >
          <Pencil size={14} />
          {startRefinement.isPending ? "creating refinement…" : "refine this task"}
        </button>
      ) : null}
      {startRefinement.isError ? (
        <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">
          {(startRefinement.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}

interface AcceptanceResultView {
  criterion: string;
  met: boolean;
  evidence?: string;
  reason?: string;
}

function AcceptancePanel({ results }: { results: AcceptanceResultView[] }) {
  const metCount = results.filter((r) => r.met).length;
  return (
    <div className="surface mb-2 p-0 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          plan acceptance ({metCount}/{results.length})
        </span>
        <div className="flex-1" />
        <span className={`chip ${metCount === results.length ? "chip-greenlit" : "chip-trashed"}`}>
          {metCount === results.length ? "all met" : "partial"}
        </span>
      </div>
      <ul className="divide-y divide-[var(--color-line)]">
        {results.map((r, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: acceptance items are positional
            key={`${r.criterion}-${i}`}
            className="px-3 py-2"
          >
            <div className="flex items-baseline gap-2">
              <span
                className={`mono text-[11px] tabular-nums w-4 text-center shrink-0 ${
                  r.met
                    ? "text-[var(--color-verdict-greenlit)]"
                    : "text-[var(--color-verdict-trashed)]"
                }`}
              >
                {r.met ? "✓" : "✗"}
              </span>
              <span className="text-[13px] text-[var(--color-fg)] leading-snug flex-1">
                {r.criterion}
              </span>
            </div>
            {r.evidence ? (
              <p className="mt-1 ml-6 mono text-[11px] text-[var(--color-fg-2)] break-words">
                evidence · {r.evidence}
              </p>
            ) : null}
            {r.reason ? (
              <p className="mt-1 ml-6 mono text-[11px] text-[var(--color-verdict-trashed)] break-words">
                reason · {r.reason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BlockerPanel({ rawQuestions }: { rawQuestions: string }) {
  let questions: string[] = [];
  try {
    const parsed = JSON.parse(rawQuestions);
    if (Array.isArray(parsed)) {
      questions = parsed.filter((q): q is string => typeof q === "string");
    }
  } catch {
    // raw was malformed; show it as-is
    questions = [rawQuestions];
  }
  return (
    <div className="surface mb-2 overflow-hidden border-l-2 border-[var(--color-verdict-trashed)]">
      <div className="px-3 py-1.5 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-verdict-trashed)]">
        agent is blocked
      </div>
      <ul className="px-3 pb-3 space-y-1.5 list-decimal list-inside text-[14px] leading-relaxed text-[var(--color-fg-1)]">
        {questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
    </div>
  );
}

function DiffPanel({ diff }: { diff: RunDiff }) {
  const { files, totalAdditions, totalDeletions, commits } = diff;
  if (files.length === 0 && commits.length === 0) {
    return (
      <div className="surface mt-2 px-3 py-2.5 mono text-[11px] text-[var(--color-fg-3)]">
        no changes recorded — agent didn't commit anything on this branch.
      </div>
    );
  }
  return (
    <div className="surface mt-2 p-0 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          changes ({files.length})
        </span>
        <div className="flex-1" />
        {totalAdditions > 0 ? (
          <span className="mono text-[11px] text-[var(--color-verdict-greenlit)] tabular-nums">
            +{totalAdditions}
          </span>
        ) : null}
        {totalDeletions > 0 ? (
          <span className="mono text-[11px] text-[var(--color-verdict-trashed)] tabular-nums">
            −{totalDeletions}
          </span>
        ) : null}
      </div>
      {commits.length > 0 ? (
        <ul className="divide-y divide-[var(--color-line)]">
          {commits.map((c) => (
            <li key={c.sha} className="px-3 py-1.5 text-[12.5px] leading-snug">
              <span className="mono text-[11px] text-[var(--color-accent)] mr-2">
                {c.sha.slice(0, 8)}
              </span>
              <span className="text-[var(--color-fg-1)]">{c.subject}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className="divide-y divide-[var(--color-line)] max-h-[260px] overflow-y-auto">
          {files.map((f) => (
            <li key={f.path} className="px-3 py-1.5 mono text-[11.5px] flex items-center gap-2">
              <span className="text-[var(--color-fg-1)] truncate flex-1">{f.path}</span>
              {f.additions > 0 ? (
                <span className="text-[var(--color-verdict-greenlit)] tabular-nums">
                  +{f.additions}
                </span>
              ) : null}
              {f.deletions > 0 ? (
                <span className="text-[var(--color-verdict-trashed)] tabular-nums">
                  −{f.deletions}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function chipForStatus(s: string): string {
  if (s === "completed") return "chip-greenlit";
  if (s === "running") return "chip-accent";
  if (s === "failed" || s === "aborted" || s === "blocked") return "chip-trashed";
  if (s === "deferred") return "chip-decompose";
  return "";
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function chipForDeferredStatus(s: string): string {
  if (s === "completed") return "chip-greenlit";
  if (s === "running" || s === "queued") return "chip-decompose";
  if (s === "failed" || s === "orphaned" || s === "cancelled") return "chip-trashed";
  return "";
}

/**
 * Shows the in-flight (or recently-finished) deferred subprocess attached
 * to a deferred run. Polls the row + log tail every few seconds so the
 * operator can watch a long build progress; deferred_task_* events folded
 * into the run channel make state transitions instantaneous instead of
 * poll-bounded.
 */
function DeferredTaskPanel({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const task = useQuery({
    queryKey: ["deferredTasks.forRun", runId],
    queryFn: () => trpc.deferredTasks.forRun.query({ runId }),
    enabled: runId.length > 0,
    // Cheap query — small DB row. Channel-driven invalidation handles the
    // hot transitions; this poll is a safety net for missed events.
    refetchInterval: 5_000,
  });
  const tail = useQuery({
    queryKey: ["deferredTasks.tail", task.data?.id],
    queryFn: () => trpc.deferredTasks.tail.query({ id: task.data?.id ?? "" }),
    enabled: Boolean(task.data?.id),
    // Poll the log tail more aggressively while the task is in flight.
    refetchInterval: task.data?.status === "running" ? 3_000 : false,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => trpc.deferredTasks.cancel.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deferredTasks.forRun", runId] });
      qc.invalidateQueries({ queryKey: ["runs.get", runId] });
    },
  });

  if (!task.data) {
    return (
      <div className="surface mb-2 px-3 py-2.5 mono text-[11.5px] text-[var(--color-fg-3)]">
        deferred — waiting for subprocess metadata…
      </div>
    );
  }

  const t = task.data;
  const elapsed = Math.max(0, Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000));
  const isLive = t.status === "running" || t.status === "queued";
  const tailContent = tail.data?.content ?? "";

  return (
    <div className="surface mb-2 p-0 overflow-hidden border-l-2 border-[var(--color-accent)]">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <Hourglass size={13} className="text-[var(--color-accent)]" />
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          deferred work
        </span>
        <span className={`chip ${chipForDeferredStatus(t.status)}`}>{t.status}</span>
        <div className="flex-1" />
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
          {fmtElapsed(elapsed)}
          {t.exitCode != null ? ` · exit ${t.exitCode}` : ""}
        </span>
        {isLive ? (
          <button
            type="button"
            onClick={() => cancel.mutate(t.id)}
            disabled={cancel.isPending}
            className="btn btn-danger !h-6 !px-2 text-[11px]"
            aria-label="cancel deferred task"
          >
            <X size={11} /> cancel
          </button>
        ) : null}
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            summary
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap">
            {t.summary}
          </p>
        </div>
        <div>
          <div className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            command
          </div>
          <pre className="mono text-[11.5px] text-[var(--color-fg-1)] whitespace-pre-wrap break-words bg-[var(--color-bg-1)] px-2 py-1 rounded-[2px] border border-[var(--color-line)]">
            {t.command}
          </pre>
        </div>
        {t.continuationRunId ? (
          <div className="text-[12px] text-[var(--color-fg-2)]">
            continuation run:{" "}
            <Link
              to={`/projects/${t.projectId}/runs/${t.continuationRunId}`}
              className="mono text-[var(--color-accent)] hover:underline"
            >
              {t.continuationRunId.slice(0, 12)}
            </Link>
          </div>
        ) : null}
      </div>
      <div className="border-t border-[var(--color-line)]">
        <div className="px-3 py-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          log tail{tail.data?.truncated ? " · (truncated)" : ""}
        </div>
        <pre className="mono text-[11.5px] text-[var(--color-fg-1)] whitespace-pre-wrap px-3 pb-2 max-h-[260px] overflow-y-auto">
          {tailContent.length > 0 ? tailContent : "(no output yet)"}
        </pre>
      </div>
    </div>
  );
}
