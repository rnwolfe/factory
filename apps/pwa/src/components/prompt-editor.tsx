import { lazy, Suspense, useEffect, useState } from "react";

// Lazy-load Monaco — it's a ~3MB chunk we don't want on the main bundle.
const MonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((mod) => ({ default: mod.Editor })),
);

interface Props {
  initialContent: string;
  /** Called whenever the editor content changes. */
  onChange: (next: string) => void;
  /** ARIA label for the editor; helpful for tests. */
  label?: string;
  /** Height in CSS units; defaults to a sensible mobile height. */
  height?: string | number;
}

/**
 * Monaco-backed markdown editor with our dispatcher's-console aesthetic
 * (warm-dark surface, mono font). Lazy-loads to keep the main bundle slim.
 */
export function PromptEditor({ initialContent, onChange, label, height }: Props) {
  // Track the value internally so we can drive Monaco's `value` prop and
  // avoid feedback loops; let parent observe via onChange.
  const [value, setValue] = useState(initialContent);

  // Reset when initialContent changes (e.g., switching prompts).
  // Bail when value is already in sync to avoid clobbering operator edits.
  useEffect(() => {
    setValue(initialContent);
  }, [initialContent]);

  return (
    <fieldset
      className="surface overflow-hidden p-0 border-0"
      aria-label={label}
      style={{ height: height ?? "60vh", minHeight: 320 }}
    >
      <Suspense
        fallback={
          <div className="h-full flex items-center justify-center mono text-[11px] text-[var(--color-fg-3)]">
            loading editor…
          </div>
        }
      >
        <MonacoEditor
          height="100%"
          defaultLanguage="markdown"
          theme="vs-dark"
          value={value}
          onChange={(next) => {
            const nextStr = next ?? "";
            setValue(nextStr);
            onChange(nextStr);
          }}
          options={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 13,
            lineNumbers: "on",
            wordWrap: "on",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderWhitespace: "selection",
            tabSize: 2,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </Suspense>
    </fieldset>
  );
}
