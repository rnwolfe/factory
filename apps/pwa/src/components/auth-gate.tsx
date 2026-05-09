import { useState } from "react";
import { useAuth } from "../lib/auth.ts";

export function AuthGate() {
  const setToken = useAuth((s) => s.setToken);
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    setErr(null);
    if (v.trim().length === 0) {
      setErr("token required");
      return;
    }
    // probe /trpc/health.ping; not strictly required but a friendlier check.
    try {
      const r = await fetch("/trpc/health.ping", {
        headers: { authorization: `Bearer ${v.trim()}` },
      });
      if (!r.ok && r.status !== 200) {
        // health.ping is public; this should rarely fail. Trust the operator.
      }
    } catch {
      // network failures don't block — we let the operator paste and proceed.
    }
    setToken(v.trim());
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-[420px] surface p-6">
        <div className="flex items-baseline justify-between mb-6">
          <span className="display text-2xl text-[var(--color-fg)]">factory</span>
          <span className="chip">v{__FACTORY_VERSION__}</span>
        </div>
        <p className="text-sm text-[var(--color-fg-2)] leading-relaxed mb-5">
          Paste the bearer token from your server's{" "}
          <span className="mono text-[var(--color-fg-1)]">~/.factory/config.yaml</span>. It is
          stored in this device's <span className="mono">localStorage</span>.
        </p>
        <input
          // biome-ignore lint/a11y/noAutofocus: single-purpose entry screen, mobile-first
          autoFocus
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          className="input mono"
          placeholder="bearer token…"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void check();
          }}
        />
        {err ? <div className="mt-2 text-xs text-[var(--color-verdict-trashed)]">{err}</div> : null}
        <button type="button" className="btn btn-primary w-full mt-4" onClick={() => void check()}>
          unlock
        </button>
        <div className="hairline mt-6" />
        <div className="mt-4 text-[11px] text-[var(--color-fg-3)] mono leading-relaxed">
          this device is now your only console for this factory.
          <br />
          rotate the token via{" "}
          <span className="text-[var(--color-fg-2)]">factoryd rotate-token</span>.
        </div>
      </div>
    </div>
  );
}
