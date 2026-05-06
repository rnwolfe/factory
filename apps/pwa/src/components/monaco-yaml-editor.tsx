import { lazy, Suspense, useEffect, useState } from "react";

const MonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((mod) => ({ default: mod.Editor })),
);

interface Props {
  initialContent: string;
  onChange?: (next: string) => void;
  /** "yaml" | "markdown" | "json" — anything Monaco recognizes. */
  language?: string;
  label?: string;
  height?: string | number;
  readOnly?: boolean;
}

/**
 * Monaco-backed text editor with our dispatcher's-console aesthetic.
 * Lazy-loads to keep the main bundle slim. Used for prompts (markdown)
 * and rubrics (yaml) and read-only blob viewers (any language).
 */
export function MonacoYamlEditor({
  initialContent,
  onChange,
  language = "yaml",
  label,
  height,
  readOnly,
}: Props) {
  const [value, setValue] = useState(initialContent);

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
          defaultLanguage={language}
          theme="vs-dark"
          value={value}
          onChange={(next) => {
            const nextStr = next ?? "";
            setValue(nextStr);
            onChange?.(nextStr);
          }}
          options={{
            readOnly: readOnly === true,
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
