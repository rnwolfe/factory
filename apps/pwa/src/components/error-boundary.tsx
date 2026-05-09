import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Used as the boundary label so multiple boundaries on a page are distinguishable in errors. */
  label: string;
  children: ReactNode;
  /** Optional fallback override. Default is the in-page error card. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Plain class-based error boundary — catches render-time errors in the
 * children subtree and shows a recoverable fallback so the rest of the
 * PWA stays interactive. Without this, a single component throwing
 * during render takes the whole app down because React's default
 * top-level handler is unforgiving (especially under concurrent
 * features).
 *
 * Each route wraps its tree in one of these so a bad live-pane render
 * doesn't take the inbox down with it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console so the operator can inspect the stack from the PWA's
    // browser devtools. Eventually this could ship to a backend collector,
    // but for a single-operator tool the console is the right surface.
    console.error(`[boundary:${this.props.label}]`, error, info.componentStack);
  }

  retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
      return (
        <div className="surface p-4 border-l-2 border-[var(--color-verdict-trashed)]">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} className="text-[var(--color-verdict-trashed)]" />
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-verdict-trashed)]">
              render error · {this.props.label}
            </span>
          </div>
          <p className="text-[14px] leading-relaxed text-[var(--color-fg-1)] mb-2">
            this part of the page hit an unhandled error. the rest of the app is still working —
            navigate away or hit retry once the underlying data settles.
          </p>
          <pre className="mono text-[11.5px] leading-snug text-[var(--color-fg-2)] whitespace-pre-wrap break-words bg-[var(--color-bg-2)] p-2 rounded max-h-[200px] overflow-y-auto mb-3">
            {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack.slice(0, 1500)}` : ""}
          </pre>
          <button
            type="button"
            className="btn"
            onClick={this.retry}
            aria-label="retry rendering this section"
          >
            <RefreshCw size={12} /> retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
