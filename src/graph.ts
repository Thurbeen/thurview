/**
 * The code graph: symbols and the references between them at a pinned commit.
 *
 * Every supported grammar ships tree-sitter's `tags.scm`, the definitions-and-
 * references query GitHub maintains for code navigation. Running it is the
 * whole per-language extraction; the rest is name resolution and graph walks.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Parser, Language, Query } from "web-tree-sitter";
import { listFiles, type LineChange } from "./git.js";
import { languageFor } from "./highlight.js";
import { catFiles } from "./symbols.js";
import { readJson, writeJson } from "./store.js";

export interface Sym {
  /** `<file>:<name>`, with `#<line>` appended when the file defines the name twice. */
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  end: number;
}

export interface Edge {
  from: string;
  to: string;
  kind: string;
  /** line of the reference, in `from`'s file */
  at: number;
}

export interface CodeGraph {
  commit: string;
  files: string[];
  symbols: Sym[];
  edges: Edge[];
  /** references that matched no definition, or several in other files */
  unresolved: number;
}

const MODULE = "<module>";

const require = createRequire(import.meta.url);
import { UndirectedGraph } from "graphology";
// CommonJS with `export =` typings; the default import is the module under NodeNext.
const louvain =
  require("graphology-communities-louvain") as typeof import("graphology-communities-louvain").default;

interface Grammar {
  pkg: string;
  wasm: string;
  /** tags queries to concatenate; TypeScript's is a delta on JavaScript's */
  tags: string[];
}

const GRAMMARS: Record<string, Grammar> = {
  javascript: {
    pkg: "tree-sitter-javascript",
    wasm: "tree-sitter-javascript.wasm",
    tags: ["tree-sitter-javascript"],
  },
  typescript: {
    pkg: "tree-sitter-typescript",
    wasm: "tree-sitter-typescript.wasm",
    tags: ["tree-sitter-javascript", "tree-sitter-typescript"],
  },
  tsx: {
    pkg: "tree-sitter-typescript",
    wasm: "tree-sitter-tsx.wasm",
    tags: ["tree-sitter-javascript", "tree-sitter-typescript"],
  },
  python: {
    pkg: "tree-sitter-python",
    wasm: "tree-sitter-python.wasm",
    tags: ["tree-sitter-python"],
  },
  go: { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm", tags: ["tree-sitter-go"] },
  rust: { pkg: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm", tags: ["tree-sitter-rust"] },
  java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm", tags: ["tree-sitter-java"] },
};
GRAMMARS["jsx"] = GRAMMARS["javascript"]!;

export const LANGUAGES = Object.keys(GRAMMARS);

function pkgDir(pkg: string): string {
  return require.resolve(`${pkg}/package.json`).replace(/package\.json$/, "");
}

interface Loaded {
  parser: Parser;
  query: Query;
}

let init: Promise<void> | null = null;
const loaded = new Map<string, Promise<Loaded>>();

function grammarFor(lang: string): Promise<Loaded> {
  let p = loaded.get(lang);
  if (!p) {
    p = (async () => {
      const gr = GRAMMARS[lang]!;
      if (!init) init = Parser.init();
      await init;
      const language = await Language.load(join(pkgDir(gr.pkg), gr.wasm));
      const scm = await Promise.all(
        gr.tags.map((t) => readFile(join(pkgDir(t), "queries", "tags.scm"), "utf8")),
      );
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, query: new Query(language, scm.join("\n")) };
    })();
    loaded.set(lang, p);
  }
  return p;
}

interface Tag {
  name: string;
  kind: string;
  role: "definition" | "reference";
  line: number;
  end: number;
}

async function tagsOf(lang: string, text: string): Promise<Tag[]> {
  const { parser, query } = await grammarFor(lang);
  const tree = parser.parse(text);
  if (!tree) return [];
  try {
    const tags: Tag[] = [];
    for (const m of query.matches(tree.rootNode)) {
      const tag = m.captures.find((c) => /^(definition|reference)\./.test(c.name));
      const name = m.captures.find((c) => c.name === "name");
      if (!tag || !name) continue;
      const [role, kind] = tag.name.split(".") as ["definition" | "reference", string];
      tags.push({
        name: name.node.text,
        kind,
        role,
        line: tag.node.startPosition.row + 1,
        end: tag.node.endPosition.row + 1,
      });
    }
    return tags;
  } finally {
    tree.delete();
  }
}

const SKIP = /(^|\/)(node_modules|dist|build|vendor|target|\.git)\//;

export function isTestFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return (
    /(^|\/)(test|tests|__tests__|spec|specs|e2e)\//.test(path) ||
    /\.(test|spec)\.\w+$|_test\.\w+$|^test_.*\.py$|Tests?\.java$/.test(name)
  );
}

/** Parse every supported file at `commit` and resolve references to definitions by name. */
export async function buildGraph(cwd: string, commit: string): Promise<CodeGraph> {
  const files = (await listFiles(cwd, commit))
    .filter((p) => GRAMMARS[languageFor(p)] && !SKIP.test(p))
    .slice(0, 4000);
  const symbols: Sym[] = [];
  const byName = new Map<string, Sym[]>();
  const pending: { file: string; defs: Sym[]; refs: Tag[] }[] = [];
  const modules = new Map<string, Sym>();

  const define = (s: Sym) => {
    symbols.push(s);
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  };

  for (let i = 0; i < files.length; i += 200) {
    const contents = await catFiles(cwd, commit, files.slice(i, i + 200));
    for (const [file, text] of contents) {
      if (text.length > 400_000) continue;
      const tags = await tagsOf(languageFor(file), text);
      // Qualify nested definitions by their enclosing ones (`Class.method`,
      // `render.onclick`) so ids survive line shifts; a repeat gets an ordinal.
      const defs: Sym[] = [];
      const qualified: string[] = [];
      const seen = new Map<string, number>();
      const ordered = tags
        .filter((t) => t.role === "definition")
        .sort((a, b) => a.line - b.line || b.end - a.end);
      for (const t of ordered) {
        let parent = "";
        for (let i = defs.length - 1; i >= 0; i--) {
          const d = defs[i]!;
          if (d.line <= t.line && t.end <= d.end && !(d.line === t.line && d.end === t.end)) {
            parent = qualified[i]!;
            break;
          }
        }
        const q = parent ? `${parent}.${t.name}` : t.name;
        const n = (seen.get(q) ?? 0) + 1;
        seen.set(q, n);
        const id = `${file}:${q}${n > 1 ? `#${n}` : ""}`;
        const s = { id, name: t.name, kind: t.kind, file, line: t.line, end: t.end };
        defs.push(s);
        qualified.push(q);
        define(s);
      }
      pending.push({ file, defs, refs: tags.filter((t) => t.role === "reference") });
    }
  }

  const edges: Edge[] = [];
  const seenEdges = new Set<string>();
  let unresolved = 0;
  for (const { file, defs, refs } of pending) {
    // innermost enclosing definition: the last one that starts at or before the line
    const enclosing = (line: number): Sym => {
      let best: Sym | null = null;
      for (const d of defs) if (d.line <= line && line <= d.end) best = d;
      if (best) return best;
      let m = modules.get(file);
      if (!m) {
        m = { id: `${file}:${MODULE}`, name: MODULE, kind: "module", file, line: 1, end: 1 };
        modules.set(file, m);
        symbols.push(m);
      }
      return m;
    };
    for (const r of refs) {
      const candidates = byName.get(r.name) ?? [];
      const target =
        candidates.find((c) => c.file === file) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!target) {
        if (candidates.length) unresolved++;
        continue;
      }
      const from = enclosing(r.line);
      const key = `${from.id}>${target.id}@${r.line}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from: from.id, to: target.id, kind: r.kind, at: r.line });
    }
  }
  return { commit, files, symbols, edges, unresolved };
}

/** Build the graph, or reuse the one cached under `dir` for that commit. */
export async function graphAt(cwd: string, commit: string, dir: string): Promise<CodeGraph> {
  const path = join(dir, "graph", `${commit}.json`);
  const cached = await readJson<CodeGraph>(path);
  if (cached && cached.commit === commit) return cached;
  const g = await buildGraph(cwd, commit);
  await writeJson(path, g);
  return g;
}

function index(g: CodeGraph) {
  const byId = new Map(g.symbols.map((s) => [s.id, s]));
  const callersOf = new Map<string, Edge[]>();
  for (const e of g.edges) {
    const list = callersOf.get(e.to) ?? [];
    list.push(e);
    callersOf.set(e.to, list);
  }
  return { byId, callersOf };
}

export interface Caller {
  symbol: string;
  file: string;
  line: number;
  at: number;
}

/** Every reference to a definition named `name`, with the symbol it sits in. */
export function callers(g: CodeGraph, name: string): Caller[] {
  const { byId, callersOf } = index(g);
  const out: Caller[] = [];
  for (const def of g.symbols.filter((s) => s.name === name))
    for (const e of callersOf.get(def.id) ?? []) {
      const from = byId.get(e.from)!;
      out.push({ symbol: from.name, file: from.file, line: from.line, at: e.at });
    }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.at - b.at);
}

export interface Reach {
  symbol: string;
  file: string;
  line: number;
  depth: number;
  via: string;
}

/** Symbols that transitively reference any of `roots`, up to `depth` hops, nearest first. */
export function reach(g: CodeGraph, roots: string[], depth: number): Reach[] {
  const { byId, callersOf } = index(g);
  const seen = new Set(roots);
  let frontier = roots;
  const out: Reach[] = [];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const e of callersOf.get(id) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        next.push(e.from);
        const s = byId.get(e.from)!;
        out.push({ symbol: s.name, file: s.file, line: s.line, depth: d, via: id });
      }
    frontier = next;
  }
  return out;
}

export interface TestHit {
  file: string;
  symbol: string;
  depth: number;
}

/** Test-file symbols that reach a definition named `name`. */
export function testsFor(g: CodeGraph, name: string, depth: number): TestHit[] {
  const roots = g.symbols.filter((s) => s.name === name).map((s) => s.id);
  return reach(g, roots, depth)
    .filter((r) => isTestFile(r.file))
    .map((r) => ({ file: r.file, symbol: r.symbol, depth: r.depth }));
}

export interface Changed {
  id: string;
  symbol: string;
  file: string;
  line: number;
  kind: string;
  change: "added" | "modified" | "removed";
}

export interface Impact {
  changed: Changed[];
  edges: { added: string[]; removed: string[] };
  reach: Reach[];
  tests: { file: string; covers: string[] }[];
  untested: string[];
  unresolved: { base: number; head: number };
}

function edgeKey(e: Edge): string {
  return `${e.from} -> ${e.to}`;
}

function touches(s: Sym, lines: Set<number> | undefined): boolean {
  if (!lines) return false;
  for (let l = s.line; l <= s.end; l++) if (lines.has(l)) return true;
  return false;
}

/** What the diff changed in the graph, and what at head depends on it. */
export function impact(
  base: CodeGraph,
  head: CodeGraph,
  changes: Map<string, LineChange>,
  depth: number,
): Impact {
  const baseIds = new Map(base.symbols.map((s) => [s.id, s]));
  const headIds = new Map(head.symbols.map((s) => [s.id, s]));
  const deletedByBasePath = new Map<string, Set<number>>();
  for (const [path, c] of changes) deletedByBasePath.set(c.oldPath ?? path, c.deleted);

  const changed: Changed[] = [];
  const row = (s: Sym, change: Changed["change"]): Changed => ({
    id: s.id,
    symbol: s.name,
    file: s.file,
    line: s.line,
    kind: s.kind,
    change,
  });
  for (const s of head.symbols) {
    if (s.name === MODULE) continue;
    if (!baseIds.has(s.id)) {
      if (changes.has(s.file)) changed.push(row(s, "added"));
    } else if (
      touches(s, changes.get(s.file)?.added) ||
      touches(baseIds.get(s.id)!, deletedByBasePath.get(s.file))
    )
      changed.push(row(s, "modified"));
  }
  for (const s of base.symbols)
    if (s.name !== MODULE && !headIds.has(s.id) && deletedByBasePath.has(s.file))
      changed.push(row(s, "removed"));

  const baseEdges = new Set(base.edges.map(edgeKey));
  const headEdges = new Set(head.edges.map(edgeKey));
  const added = [...headEdges].filter((k) => !baseEdges.has(k)).sort();
  const removed = [...baseEdges].filter((k) => !headEdges.has(k)).sort();

  const roots = changed.filter((c) => c.change !== "removed").map((c) => c.id);
  const r = reach(head, roots, depth);
  const covers = new Map<string, Set<string>>();
  const { callersOf } = index(head);
  for (const root of roots) {
    const seen = new Set([root]);
    let frontier = [root];
    for (let d = 0; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const s = headIds.get(id)!;
        if (isTestFile(s.file)) {
          const set = covers.get(s.file) ?? new Set();
          set.add(root);
          covers.set(s.file, set);
        }
        for (const e of callersOf.get(id) ?? [])
          if (!seen.has(e.from)) {
            seen.add(e.from);
            next.push(e.from);
          }
      }
      frontier = next;
    }
  }
  const tested = new Set([...covers.values()].flatMap((s) => [...s]));
  return {
    changed,
    edges: { added, removed },
    reach: r.filter((x) => !isTestFile(x.file)),
    tests: [...covers]
      .map(([file, set]) => ({ file, covers: [...set].sort() }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    untested: roots.filter((id) => !tested.has(id)).sort(),
    unresolved: { base: base.unresolved, head: head.unresolved },
  };
}

export interface Community {
  id: string;
  label: string;
  files: string[];
  symbols: number;
  /** most referenced symbols, the names a reader would know the cluster by */
  hubs: string[];
}

export interface Architecture {
  communities: Community[];
  edges: { from: string; to: string; references: number }[];
  diff: { added: string[]; removed: string[]; addedFiles: string[]; removedFiles: string[] };
}

function fileEdges(g: CodeGraph): Map<string, number> {
  const byId = new Map(g.symbols.map((s) => [s.id, s.file]));
  const out = new Map<string, number>();
  for (const e of g.edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    if (a === b) continue;
    const k = `${a} -> ${b}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function mainDir(files: string[]): string {
  const count = new Map<string, number>();
  for (const f of files) {
    const dir = f.split("/").slice(0, -1).join("/") || ".";
    count.set(dir, (count.get(dir) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

/** Files clustered by how they reference each other at head, and the file-level diff against base. */
export function architecture(base: CodeGraph, head: CodeGraph): Architecture {
  const headEdges = fileEdges(head);
  const baseEdges = fileEdges(base);
  const g = new UndirectedGraph();
  const withSymbols = new Set(head.symbols.map((s) => s.file));
  for (const f of head.files) if (withSymbols.has(f)) g.addNode(f);
  for (const [k, w] of headEdges) {
    const [a, b] = k.split(" -> ") as [string, string];
    if (g.hasEdge(a, b)) g.updateEdgeAttribute(a, b, "weight", (x: number) => x + w);
    else g.addEdge(a, b, { weight: w });
  }
  const membership: Record<string, number> = g.order ? louvain(g, { getEdgeWeight: "weight" }) : {};
  const groups = new Map<number, string[]>();
  for (const [file, c] of Object.entries(membership)) {
    const list = groups.get(c) ?? [];
    list.push(file);
    groups.set(c, list);
  }
  const symbolsPerFile = new Map<string, number>();
  for (const s of head.symbols) symbolsPerFile.set(s.file, (symbolsPerFile.get(s.file) ?? 0) + 1);
  const fanIn = new Map<string, number>();
  for (const e of head.edges) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
  const symbolsIn = new Map<string, Sym[]>();
  for (const s of head.symbols) {
    const list = symbolsIn.get(s.file) ?? [];
    list.push(s);
    symbolsIn.set(s.file, list);
  }
  const communities: Community[] = [...groups.values()]
    .map((files) => files.sort())
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
    .map((files, i) => ({
      id: `c${i + 1}`,
      label: mainDir(files),
      files,
      symbols: files.reduce((n, f) => n + (symbolsPerFile.get(f) ?? 0), 0),
      hubs: files
        .flatMap((f) => symbolsIn.get(f) ?? [])
        .filter((s) => s.name !== MODULE && fanIn.has(s.id))
        .sort((a, b) => fanIn.get(b.id)! - fanIn.get(a.id)! || a.name.localeCompare(b.name))
        .slice(0, 3)
        .map((s) => s.name),
    }));
  const communityOf = new Map<string, string>();
  for (const c of communities) for (const f of c.files) communityOf.set(f, c.id);
  const between = new Map<string, number>();
  for (const [k, w] of headEdges) {
    const [a, b] = k.split(" -> ") as [string, string];
    const ca = communityOf.get(a)!;
    const cb = communityOf.get(b)!;
    if (ca === cb) continue;
    const key = `${ca} -> ${cb}`;
    between.set(key, (between.get(key) ?? 0) + w);
  }
  const headFiles = new Set(head.files);
  const baseFiles = new Set(base.files);
  return {
    communities,
    edges: [...between]
      .map(([k, references]) => {
        const [from, to] = k.split(" -> ") as [string, string];
        return { from, to, references };
      })
      .sort((a, b) => b.references - a.references),
    diff: {
      added: [...headEdges.keys()].filter((k) => !baseEdges.has(k)).sort(),
      removed: [...baseEdges.keys()].filter((k) => !headEdges.has(k)).sort(),
      addedFiles: head.files.filter((f) => !baseFiles.has(f)),
      removedFiles: base.files.filter((f) => !headFiles.has(f)),
    },
  };
}
