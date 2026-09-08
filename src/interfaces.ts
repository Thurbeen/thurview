/**
 * The interface delta: what the change did to the surfaces other code can reach.
 *
 * A capability becomes real when it becomes visible, so the honest answer to
 * "what does this pull request do" is what it added to, changed in, or took out
 * of the exported surface. That is derived here from the code graph at both
 * pinned commits rather than asserted by the author, so it cannot go stale: a
 * symbol the diff touched is an interface entry only when it is visible outside
 * its file on one side or the other, and only when its declaration moved.
 * Everything else is counted as internal, which is a finding of its own.
 */
import { languageFor } from "./highlight.js";
import { catFiles } from "./symbols.js";
import { LANGUAGES, type CodeGraph, type Impact, type Sym } from "./graph.js";
import type { ChangedFile, LineChange } from "./git.js";

export interface InterfaceEntry {
  /** the graph symbol id, or `authored:<key>` for an entry the agent declared */
  id: string;
  change: "added" | "changed" | "removed";
  /** what a consumer names it: the declaration, or the agent's own words */
  name: string;
  /** the base declaration when the surface changed, otherwise empty */
  was: string;
  kind: string;
  file: string;
  line: number;
  /** which pinned commit `file` and `line` belong to */
  graph: "head" | "base";
  /** what this lets a consumer do, written by the agent */
  capability?: string;
  /** authored entries: the anchor that proves the entry is in this diff */
  anchor?: string;
}

export interface InterfaceDelta {
  entries: InterfaceEntry[];
  /** symbols the diff changed without moving a visible surface */
  internal: number;
  /** changed files no supported grammar could read, so an interface may hide there */
  unreadable: string[];
  /** the whole answer in one sentence, for the agent and the reader alike */
  verdict: string;
  truncated: { base: boolean; head: boolean };
}

type Family = "js" | "python" | "go" | "rust" | "java";

const FAMILY: Record<string, Family> = {
  typescript: "js",
  tsx: "js",
  javascript: "js",
  jsx: "js",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
};

/** Kinds whose body is part of the surface: a field added to an exported type is a change. */
const BODY_IS_SURFACE = new Set(["interface", "type"]);

const MAX_SURFACE_LINES = 60;
const MAX_DECLARATION_LINES = 12;
const MAX_DECLARATION_CHARS = 240;

/** `export { audit, check as verify }` makes the local names visible outside the file. */
function reexportedNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const local = part
        .split(/\s+as\s+/)[0]!
        .replace(/\btype\b/, "")
        .trim();
      if (local) out.add(local);
    }
  return out;
}

/**
 * The declaration a consumer reads: the definition's head, without its opening
 * brace. The parameter list is followed to its close before a brace can end the
 * declaration, so an object parameter does not cut the signature in half.
 */
function declarationOf(lines: string[], s: Sym): string {
  const parts: string[] = [];
  const last = Math.min(s.end, s.line + MAX_DECLARATION_LINES - 1);
  let open = 0;
  let whole = false;
  for (let n = s.line; n <= last && !whole; n++) {
    const line = lines[n - 1] ?? "";
    parts.push(line.trim());
    for (const c of line) open += c === "(" ? 1 : c === ")" ? -1 : 0;
    whole = open <= 0 && (/[{;]/.test(line) || /:\s*$/.test(line.trim()));
  }
  const text = parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s*[{;]\s*$/, "")
    .trim();
  const cut = text.length > MAX_DECLARATION_CHARS;
  return cut ? `${text.slice(0, MAX_DECLARATION_CHARS)} ...` : whole ? text : `${text} ...`;
}

/** The text compared to decide whether the surface moved. */
function surfaceOf(lines: string[], s: Sym): string {
  if (!BODY_IS_SURFACE.has(s.kind)) return declarationOf(lines, s);
  return lines
    .slice(s.line - 1, Math.min(s.end, s.line + MAX_SURFACE_LINES - 1))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function qualifiedOf(s: Sym): string {
  return s.id.slice(s.file.length + 1).replace(/#\d+$/, "");
}

/** Symbol ids visible outside their own file, for the files the diff touched. */
function visibleIds(graph: CodeGraph, texts: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const byFile = new Map<string, Sym[]>();
  for (const s of graph.symbols) {
    if (!texts.has(s.file)) continue;
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }
  for (const [file, syms] of byFile) {
    const family = FAMILY[languageFor(file)];
    if (!family) continue;
    const text = texts.get(file)!;
    const lines = text.split("\n");
    const reexported = family === "js" ? reexportedNames(text) : new Set<string>();
    // parents first, so a method can ask whether the type holding it is visible
    const exported = new Set<string>();
    for (const s of [...syms].sort((a, b) => a.line - b.line)) {
      const decl = (lines[s.line - 1] ?? "").trim();
      const declares = (): boolean => {
        switch (family) {
          case "js":
            return /^export\b/.test(decl) || reexported.has(s.name);
          case "python":
            return !s.name.startsWith("_") || /^__\w+__$/.test(s.name);
          case "go":
            return /^[A-Z]/.test(s.name);
          case "rust":
            return /^pub(\s|\()/.test(decl);
          case "java":
            return /\bpublic\b/.test(decl);
        }
      };
      const q = qualifiedOf(s);
      const parent = q.includes(".") ? q.slice(0, q.lastIndexOf(".")) : "";
      let visible: boolean;
      if (!parent) visible = declares();
      // a method rides on its type's visibility, except in Rust where `pub` is on the line
      else if (family === "rust") visible = declares();
      else if (family === "js")
        visible =
          exported.has(parent) && s.kind === "method" && !/^(private|protected|#)/.test(decl);
      else visible = exported.has(parent) && declares();
      if (!visible) continue;
      exported.add(q);
      out.add(s.id);
    }
  }
  return out;
}

function verdictOf(entries: InterfaceEntry[], internal: number, unreadable: number): string {
  const counts = (["removed", "changed", "added"] as const)
    .map((c) => [c, entries.filter((e) => e.change === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${c}`);
  const head = counts.length
    ? `${counts.join(", ")}.`
    : internal
      ? `No interface moved. ${internal} symbol${internal > 1 ? "s" : ""} changed inside, with no visible surface.`
      : "No interface moved.";
  const tail = unreadable
    ? ` ${unreadable} changed file${unreadable > 1 ? "s are" : " is"} outside the code graph.`
    : "";
  return head + tail;
}

const RANK: Record<InterfaceEntry["change"], number> = { removed: 0, changed: 1, added: 2 };

/** Removed first: it is the entry a reviewer must not miss. */
export function sortEntries(entries: InterfaceEntry[]): InterfaceEntry[] {
  return entries.sort(
    (a, b) =>
      RANK[a.change] - RANK[b.change] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.name.localeCompare(b.name),
  );
}

/** Re-derive the verdict after authored entries joined the derived ones. */
export function withVerdict(delta: InterfaceDelta): InterfaceDelta {
  sortEntries(delta.entries);
  delta.verdict = verdictOf(delta.entries, delta.internal, delta.unreadable.length);
  return delta;
}

/** What the change did to the surfaces other code can reach, at the pinned commits. */
export async function interfaceDelta(input: {
  cwd: string;
  pins: { base: string; head: string };
  base: CodeGraph;
  head: CodeGraph;
  impact: Impact;
  changes: Map<string, LineChange>;
  changed: ChangedFile[];
}): Promise<InterfaceDelta> {
  const headSyms = new Map(input.head.symbols.map((s) => [s.id, s]));
  const baseSyms = new Map(input.base.symbols.map((s) => [s.id, s]));
  const headPaths = new Set<string>();
  const basePaths = new Set<string>();
  for (const row of input.impact.changed) {
    if (row.change === "removed") basePaths.add(row.file);
    else {
      headPaths.add(row.file);
      basePaths.add(input.changes.get(row.file)?.oldPath ?? row.file);
    }
  }
  const [headText, baseText] = await Promise.all([
    catFiles(input.cwd, input.pins.head, [...headPaths]),
    catFiles(input.cwd, input.pins.base, [...basePaths]),
  ]);
  const headVisible = visibleIds(input.head, headText);
  const baseVisible = visibleIds(input.base, baseText);

  const entries: InterfaceEntry[] = [];
  let internal = 0;
  for (const row of input.impact.changed) {
    const oldPath = row.change === "removed" ? row.file : input.changes.get(row.file)?.oldPath;
    const baseId =
      row.change === "removed"
        ? row.id
        : oldPath
          ? `${oldPath}${row.id.slice(row.file.length)}`
          : row.id;
    const headSym = row.change === "removed" ? undefined : headSyms.get(row.id);
    const baseSym = baseSyms.get(baseId);
    const wasVisible = !!baseSym && baseVisible.has(baseId);
    const isVisible = !!headSym && headVisible.has(row.id);
    if (!wasVisible && !isVisible) {
      internal++;
      continue;
    }
    const entry = (change: InterfaceEntry["change"], sym: Sym, lines: string[], was: string) =>
      entries.push({
        id: change === "removed" ? baseId : row.id,
        change,
        name: declarationOf(lines, sym),
        was,
        kind: sym.kind,
        file: sym.file,
        line: sym.line,
        graph: change === "removed" ? "base" : "head",
      });
    const headLines = headSym ? (headText.get(headSym.file) ?? "").split("\n") : [];
    const baseLines = baseSym ? (baseText.get(baseSym.file) ?? "").split("\n") : [];
    if (!wasVisible) entry("added", headSym!, headLines, "");
    else if (!isVisible) entry("removed", baseSym!, baseLines, "");
    else if (surfaceOf(headLines, headSym!) !== surfaceOf(baseLines, baseSym!)) {
      const was = declarationOf(baseLines, baseSym!);
      entry("changed", headSym!, headLines, was === declarationOf(headLines, headSym!) ? "" : was);
    } else internal++;
  }

  const unreadable = input.changed
    .filter((f) => !LANGUAGES.includes(languageFor(f.path)))
    .map((f) => f.path);
  return withVerdict({
    entries,
    internal,
    unreadable,
    verdict: "",
    truncated: input.impact.truncated,
  });
}
