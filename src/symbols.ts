import { spawn } from "node:child_process";
import { listFiles } from "./git.js";
import { languageFor } from "./highlight.js";

export interface SymbolDef {
  name: string;
  path: string;
  line: number;
  kind: string;
}

type Rule = { re: RegExp; kind: string; group?: number };

const COMMON: Rule[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  {
    re: /^\s*(?:export\s+)?(?:interface|enum|trait|struct|union|module|namespace|protocol|record)\s+([A-Za-z_$][\w$]*)/,
    kind: "type",
  },
];

const RULES: Record<string, Rule[]> = {
  typescript: [
    ...COMMON,
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    {
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
      kind: "variable",
    },
    {
      re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|override\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;=]+)?\{/,
      kind: "method",
    },
  ],
  python: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: "constant" },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: "variable" },
  ],
  rust: [
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
      kind: "function",
    },
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod|union)\s+([A-Za-z_]\w*)/,
      kind: "type",
    },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_]\w*)/, kind: "impl" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/, kind: "constant" },
  ],
  ruby: [
    { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: "method" },
    { re: /^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/, kind: "class" },
  ],
  lua: [
    { re: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/, kind: "function" },
    { re: /^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*function/, kind: "function" },
  ],
  bash: [{ re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{?/, kind: "function" }],
  clike: [
    ...COMMON,
    {
      re: /^[\w<>\[\],:\s*&]+?\s\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:throws\s+[\w,\s]+)?\{?\s*$/,
      kind: "function",
    },
    {
      re: /^\s*(?:public|private|protected|internal|static|final|abstract|virtual|override|async|\s)*[\w<>\[\],?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[\w,\s]+)?\{?\s*$/,
      kind: "method",
    },
  ],
  elixir: [
    { re: /^\s*defmodule\s+([\w.]+)/, kind: "module" },
    { re: /^\s*defp?\s+([a-z_]\w*[?!]?)/, kind: "function" },
  ],
};

const FAMILY: Record<string, string> = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "typescript",
  jsx: "typescript",
  vue: "typescript",
  svelte: "typescript",
  python: "python",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  lua: "lua",
  bash: "bash",
  fish: "bash",
  java: "clike",
  kotlin: "clike",
  csharp: "clike",
  c: "clike",
  cpp: "clike",
  swift: "clike",
  scala: "clike",
  dart: "clike",
  php: "clike",
  "objective-c": "clike",
  elixir: "elixir",
};

async function catFiles(
  cwd: string,
  commit: string,
  paths: string[],
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], { cwd });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", reject);
    proc.on("close", () => {
      const buf = Buffer.concat(chunks);
      const out = new Map<string, string>();
      let pos = 0;
      let i = 0;
      while (pos < buf.length && i < paths.length) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString();
        pos = nl + 1;
        const path = paths[i++]!;
        if (header.endsWith(" missing")) continue;
        const size = Number(header.split(" ")[2]);
        const body = buf.subarray(pos, pos + size);
        pos += size + 1;
        if (!body.includes(0)) out.set(path, body.toString("utf8"));
      }
      resolve(out);
    });
    proc.stdin.write(paths.map((p) => `${commit}:${p}\n`).join(""));
    proc.stdin.end();
  });
}

export class SymbolIndex {
  private defs = new Map<string, SymbolDef[]>();
  private built: Promise<void> | null = null;

  constructor(
    private cwd: string,
    private commit: string,
  ) {}

  private async build(): Promise<void> {
    const files = (await listFiles(this.cwd, this.commit))
      .filter(
        (p) => FAMILY[languageFor(p)] && !/(^|\/)(node_modules|dist|build|vendor|\.git)\//.test(p),
      )
      .slice(0, 4000);
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      const contents = await catFiles(this.cwd, this.commit, batch);
      for (const [path, text] of contents) {
        if (text.length > 400_000) continue;
        const rules = RULES[FAMILY[languageFor(path)] ?? ""] ?? [];
        const lines = text.split("\n");
        for (let n = 0; n < lines.length; n++) {
          const line = lines[n]!;
          if (line.length > 400) continue;
          for (const r of rules) {
            const m = r.re.exec(line);
            if (m) {
              const name = m[r.group ?? 1]!;
              const short = name.split(/[.:]/).pop()!;
              const def = { name: short, path, line: n + 1, kind: r.kind };
              const list = this.defs.get(short) ?? [];
              if (!list.some((d) => d.path === path && d.line === def.line)) list.push(def);
              this.defs.set(short, list);
              break;
            }
          }
        }
      }
    }
  }

  async lookup(name: string): Promise<SymbolDef[]> {
    if (!this.built) this.built = this.build();
    await this.built;
    return this.defs.get(name) ?? [];
  }
}

const indexes = new Map<string, SymbolIndex>();

export function symbolIndex(cwd: string, commit: string): SymbolIndex {
  const key = `${cwd}@${commit}`;
  let idx = indexes.get(key);
  if (!idx) {
    idx = new SymbolIndex(cwd, commit);
    indexes.set(key, idx);
  }
  return idx;
}
