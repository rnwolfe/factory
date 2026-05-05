/**
 * Map a path extension to a Monaco language id. Lowercase input expected.
 * Returns "plaintext" as a default — Monaco accepts unknown ids but the
 * editor's syntax highlighting will silently no-op there.
 */
const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  sql: "sql",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
};

const FILENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

export function langFromPath(path: string): string {
  const last = path.split("/").pop() ?? path;
  const lower = last.toLowerCase();
  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower] ?? "plaintext";
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx < 0 || dotIdx === lower.length - 1) return "plaintext";
  const ext = lower.slice(dotIdx + 1);
  return EXT_MAP[ext] ?? "plaintext";
}
