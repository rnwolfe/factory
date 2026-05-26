import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ClipboardCopy, LifeBuoy, Loader2, Terminal } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface InterventionContextView {
  scenario: string;
  title: string;
  prompt: string;
  runId: string | null;
  projectId: string | null;
  agent: string | null;
}

/** The agent ids the session orchestrator accepts as interactive modes. */
const INTERACTIVE_MODES = new Set(["claude-code", "codex"]);

/**
 * Copy-pastable operator-intervention prompt rendered inside a decision card.
 *
 * The prompt body is scenario-specific (built daemon-side via
 * `recoveryPromptsRouter.forDecision`) and carries the full context an
 * operator needs to drive a recovery in their preferred agent — worktree
 * path, branch, base ref, conflicted files, blocking questions, the task
 * body. The component itself is opaque: it doesn't reach into the body and
 * doesn't know the scenario set.
 *
 * Returns `null` when the decision kind doesn't need a prompt (tag_change,
 * triage, agent_decision). Callers can always render this; it disappears
 * gracefully.
 *
 * The "open in agent session" path is a planned follow-up — it needs the
 * session-attach-to-existing-worktree wiring that ad-hoc sessions don't
 * have yet (today's `sessions.start` creates a fresh worktree off main).
 * Copy-paste is the supported v1 path.
 */
export function RecoveryPrompt({ decisionId }: { decisionId: string }) {
  const q = useQuery({
    queryKey: ["recoveryPrompts.forDecision", decisionId],
    queryFn: () =>
      trpc.recoveryPrompts.forDecision.query({
        decisionId,
      }) as Promise<InterventionContextView | null>,
    staleTime: 60 * 1000,
  });

  if (q.isLoading || q.isError) return null;
  if (!q.data) return null;
  return <PromptBlock entry={q.data} />;
}

function PromptBlock({ entry }: { entry: InterventionContextView }) {
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();
  const canOpenInSession =
    !!entry.projectId && !!entry.runId && !!entry.agent && INTERACTIVE_MODES.has(entry.agent);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / non-secure contexts — fall back to a selectable
      // textarea; the operator can ⌘A + ⌘C manually. We don't have one
      // anymore (we render the prompt as <pre>), so document.execCommand
      // is the legacy seam. Best effort.
      const range = document.createRange();
      const sel = document.getSelection();
      const node = document.getElementById("recovery-prompt-body");
      if (node && sel) {
        sel.removeAllRanges();
        range.selectNodeContents(node);
        sel.addRange(range);
      }
    }
  };

  const openInSession = useMutation({
    mutationFn: async () => {
      if (!entry.projectId || !entry.runId || !entry.agent) {
        throw new Error("missing run / project / agent context");
      }
      const res = (await trpc.sessions.start.mutate({
        projectId: entry.projectId,
        mode: entry.agent as "claude-code" | "codex",
        description: `recovery: ${entry.title}`,
        fromRunId: entry.runId,
        initialPrompt: entry.prompt,
      } as never)) as { id: string };
      return res.id;
    },
    onSuccess: (sessionId) => {
      if (entry.projectId) nav(`/projects/${entry.projectId}/sessions/${sessionId}`);
    },
  });

  return (
    <div className="surface px-3 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <LifeBuoy size={13} className="text-[var(--color-accent)] shrink-0" />
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          recovery prompt
        </span>
        <span className="text-[12.5px] text-[var(--color-fg-1)] truncate">{entry.title}</span>
      </div>
      <p className="mono text-[10.5px] text-[var(--color-fg-3)] leading-relaxed">
        copy this into an interactive agent (claude or codex) running anywhere — it carries
        everything needed to drive the recovery.
      </p>
      <pre
        id="recovery-prompt-body"
        className="mono text-[11px] leading-relaxed text-[var(--color-fg-1)] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded p-3 whitespace-pre-wrap break-words max-h-[260px] overflow-y-auto"
      >
        {entry.prompt}
      </pre>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={copy}
          className="btn btn-ghost text-[11px] !h-7 flex items-center gap-1.5"
          aria-label="copy recovery prompt to clipboard"
        >
          {copied ? <Check size={11} /> : <ClipboardCopy size={11} />}
          {copied ? "copied" : "copy prompt"}
        </button>
        {canOpenInSession ? (
          <button
            type="button"
            onClick={() => openInSession.mutate()}
            disabled={openInSession.isPending}
            className="btn text-[11px] !h-7 flex items-center gap-1.5"
            title={`opens an interactive ${entry.agent === "codex" ? "codex" : "claude"} session attached to the run's worktree, with this prompt pre-typed`}
          >
            {openInSession.isPending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Terminal size={11} />
            )}
            open in {entry.agent === "codex" ? "codex" : "claude"} session
          </button>
        ) : null}
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
          {entry.prompt.length.toLocaleString()} chars · scenario:{" "}
          <span className="text-[var(--color-fg-2)]">{entry.scenario}</span>
        </span>
      </div>
      {openInSession.isError ? (
        <p className="mono text-[10.5px] text-[var(--color-verdict-trashed)] leading-relaxed">
          {(openInSession.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}
