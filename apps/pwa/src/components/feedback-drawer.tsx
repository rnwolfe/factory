import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

interface Props {
  onClose: () => void;
  contextRoute: string;
  contextHint: string;
}

export function FeedbackDrawer({ onClose, contextRoute, contextHint }: Props) {
  const [vote, setVote] = useState<"up" | "down">("up");
  const [body, setBody] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const qc = useQueryClient();

  const submit = useMutation({
    mutationFn: () =>
      trpc.feedback.submit.mutate({
        vote,
        body,
        contextRoute,
        contextHint,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feedback.inbox"] });
      setSubmitted(true);
      setTimeout(onClose, 800);
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="surface w-full max-w-md max-h-[90vh] overflow-y-auto p-4 space-y-3 rounded-t-lg"
        style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-start justify-between">
          <span className="display text-lg">feedback on Heimdall</span>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost h-8 px-2"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        <p className="text-[12px] text-[var(--color-fg-3)] leading-relaxed">
          captured from <span className="mono text-[var(--color-fg-2)]">{contextHint}</span>. routed
          to the inbox; iterate with the agent later.
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setVote("up")}
            aria-pressed={vote === "up"}
            style={
              vote === "up"
                ? {
                    borderColor: "var(--color-verdict-greenlit)",
                    backgroundColor: "var(--color-verdict-greenlit-soft)",
                  }
                : undefined
            }
            className={`flex-1 surface flex items-center justify-center gap-1.5 h-10 text-[13px] ${
              vote === "up"
                ? "text-[var(--color-verdict-greenlit)]"
                : "border-[var(--color-line)] text-[var(--color-fg-2)]"
            } border`}
          >
            <ThumbsUp size={14} /> works for me
          </button>
          <button
            type="button"
            onClick={() => setVote("down")}
            aria-pressed={vote === "down"}
            style={
              vote === "down"
                ? {
                    borderColor: "var(--color-verdict-trashed)",
                    backgroundColor: "var(--color-verdict-trashed-soft)",
                  }
                : undefined
            }
            className={`flex-1 surface flex items-center justify-center gap-1.5 h-10 text-[13px] ${
              vote === "down"
                ? "text-[var(--color-verdict-trashed)]"
                : "border-[var(--color-line)] text-[var(--color-fg-2)]"
            } border`}
          >
            <ThumbsDown size={14} /> friction
          </button>
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="what's on your mind? (one line is fine)"
          className="surface w-full px-2 py-1.5 mono text-[12.5px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
        />

        <div className="flex items-center justify-between gap-2">
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{body.length} / 1000</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost text-[12px]">
              cancel
            </button>
            <button
              type="button"
              onClick={() => submit.mutate()}
              disabled={body.length === 0 || submit.isPending || submitted}
              className="btn btn-primary text-[12px]"
            >
              {submitted ? (
                "captured"
              ) : submit.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> sending…
                </>
              ) : (
                "capture"
              )}
            </button>
          </div>
        </div>

        {submit.isError ? (
          <div className="text-[12px] text-[var(--color-verdict-trashed)]">
            {(submit.error as Error).message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
