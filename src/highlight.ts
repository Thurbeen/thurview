import {
  createHighlighter,
  bundledLanguages,
  type Highlighter,
  type ThemeRegistration,
} from "shiki";
import { theme } from "./highlight-theme.js";

const EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  m: "objective-c",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  sql: "sql",
  graphql: "graphql",
  nix: "nix",
  tf: "hcl",
  hcl: "hcl",
  dockerfile: "dockerfile",
  vue: "vue",
  svelte: "svelte",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  scala: "scala",
  clj: "clojure",
  dart: "dart",
  zig: "zig",
  proto: "proto",
  cmake: "cmake",
  make: "makefile",
  mk: "makefile",
  ini: "ini",
  cfg: "ini",
  diff: "diff",
  patch: "diff",
  txt: "text",
  csv: "csv",
  svg: "xml",
};

const NAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  CMakeLists: "cmake",
};

export function languageFor(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (NAME[name]) return NAME[name] as string;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  return EXT[ext] ?? "text";
}

let hl: Promise<Highlighter> | null = null;
const registered = new Set<string>(["thurview"]);

async function highlighter(): Promise<Highlighter> {
  if (!hl) hl = createHighlighter({ themes: [theme], langs: [] });
  return hl;
}

/** Register a per-review highlighter theme; repeated registrations are no-ops. */
export async function registerTheme(reg: ThemeRegistration): Promise<string> {
  const name = reg.name ?? "thurview";
  if (!registered.has(name)) {
    await (await highlighter()).loadTheme(reg);
    registered.add(name);
  }
  return name;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const cache = new Map<string, string[]>();

/** Highlight a whole file; returns one HTML fragment per line (no trailing newline line). */
export async function highlightLines(
  code: string,
  lang: string,
  cacheKey?: string,
  themeName = "thurview",
): Promise<string[]> {
  if (cacheKey) cacheKey = `${themeName}|${cacheKey}`;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;
  const lines = code.endsWith("\n") ? code.slice(0, -1).split("\n") : code.split("\n");
  let out: string[];
  if (lang === "text" || !(lang in bundledLanguages) || code.length > 1_500_000) {
    out = lines.map(escapeHtml);
  } else {
    const h = await highlighter();
    if (!h.getLoadedLanguages().includes(lang)) {
      try {
        await h.loadLanguage(lang as never);
      } catch {
        out = lines.map(escapeHtml);
        return remember(cacheKey, out);
      }
    }
    const result = h.codeToTokens(code, { lang: lang as never, theme: themeName });
    out = result.tokens.map((toks) =>
      toks
        .map((t) => {
          const style = [
            t.color ? `color:${t.color}` : "",
            t.fontStyle === 2 ? "font-style:italic" : t.fontStyle === 1 ? "font-weight:700" : "",
          ]
            .filter(Boolean)
            .join(";");
          return style
            ? `<span style="${style}">${escapeHtml(t.content)}</span>`
            : escapeHtml(t.content);
        })
        .join(""),
    );
    // keep counts aligned with `lines`: shiki may add or drop a trailing empty line
    while (out.length < lines.length) out.push("");
    if (out.length > lines.length) out.length = lines.length;
  }
  return remember(cacheKey, out);
}

function remember(key: string | undefined, v: string[]): string[] {
  if (key) {
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    cache.set(key, v);
  }
  return v;
}

export { escapeHtml };
