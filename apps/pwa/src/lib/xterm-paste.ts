import type { Terminal } from "@xterm/xterm";

/**
 * Wire clipboard-paste into an xterm terminal so Cmd/Ctrl+V, the browser
 * paste event, and the mobile paste menu all route through `term.paste()`.
 *
 * Why this exists:
 *
 * 1. **Bracketed-paste correctness.** When the inner program (neovim,
 *    fish/zsh on most setups) enables bracketed paste mode by emitting
 *    `\x1b[?2004h`, that sequence flows through tmux → our `/ws/pane`
 *    stream → xterm.js, which tracks the mode internally. `term.paste()`
 *    wraps the text in `\x1b[200~ … \x1b[201~`; raw `term.onData(text)`
 *    does not. Letting xterm's hidden helper textarea handle the paste
 *    via its default input pipeline can fire the bytes character-by-
 *    character without the wrapping, which in neovim insert mode looks
 *    like a sequence of keystrokes — each newline triggers an auto-indent
 *    cascade, comments smear, and contiguous indentation snowballs.
 *
 * 2. **Mobile paste menu.** The helper textarea xterm.js renders is
 *    positioned off-screen (`left: -9999em`), so a long-press on the
 *    visible terminal won't show the iOS/Android paste UI on it. Once
 *    the textarea is focused (via tap-to-focus from `wireXtermTouchScroll`)
 *    and the user invokes paste from the OS, the event still dispatches
 *    against the focused element — which sits inside `container`. A
 *    capture-phase paste listener on the container picks it up regardless
 *    of which descendant is the target.
 *
 * 3. **Hardware-keyboard chord on virtual-keyboard surfaces.** iPad
 *    Smart Keyboard and some Android IMEs send Cmd-V as a `keydown` with
 *    `metaKey/ctrlKey + key='v'` but do NOT also fire a paste event. If
 *    we ignored the keydown, xterm.js would forward a literal `v` byte
 *    to tmux. We intercept the chord, read `navigator.clipboard.readText()`,
 *    and route through `term.paste()`.
 *
 * Returns a cleanup that removes the listeners. The `attachCustomKeyEventHandler`
 * slot is reset to a no-op passthrough because xterm.js has no detach
 * API for it; this matters if a future wiring layers additional handlers
 * around this one.
 */
export function wireXtermPaste(term: Terminal, container: HTMLElement): () => void {
  const doPaste = (text: string) => {
    if (!text) return;
    // term.paste() applies prepareTextForTerminal (CRLF/LF → CR) AND wraps
    // with bracketed-paste markers when term.modes.bracketedPasteMode is on,
    // then emits via onData — which the WS layer already forwards to tmux
    // as binary frames. We don't need to inspect the mode ourselves; that's
    // the whole point of routing through term.paste rather than onData.
    term.paste(text);
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!text) return;
    // Run in capture so we intercept before xterm.js's hidden helper
    // textarea processes the event. stopPropagation prevents the textarea's
    // own paste handler from also firing term.paste — without it, you get
    // each pasted byte twice.
    e.preventDefault();
    e.stopPropagation();
    doPaste(text);
  };
  container.addEventListener("paste", onPaste, { capture: true });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const isPasteChord = (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "v" || e.key === "V");
    if (!isPasteChord) return true;
    // The async clipboard API is the only way to read the system clipboard
    // from a keydown handler (the synchronous `document.execCommand("paste")`
    // is gone in modern browsers). If it's unavailable, fall through and let
    // the browser dispatch a native paste event that our container listener
    // will catch — that path doesn't need clipboard permissions.
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return true;
    }
    e.preventDefault();
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) doPaste(text);
      })
      .catch(() => {
        // Clipboard read denied (no user activation, no permission). The
        // operator's next paste via the OS context menu will still work —
        // that fires a paste event with clipboardData populated and bypasses
        // the async-API permission gate.
      });
    return false;
  });

  return () => {
    container.removeEventListener("paste", onPaste, { capture: true } as EventListenerOptions);
    term.attachCustomKeyEventHandler(() => true);
  };
}
