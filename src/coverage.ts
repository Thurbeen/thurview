/**
 * What an explainer examined, and what it did not.
 *
 * A review is bounded by its diff, so its own scope is the reader's proof that
 * nothing was skipped. A codebase has no such bound: prose over a whole repo
 * either runs unreadably long or quietly leaves most of the system out, and an
 * explanation that leaves things out silently is misleading about architecture.
 *
 * So coverage is DERIVED here rather than claimed in prose. Every file at the
 * pinned commit inside the scope is accounted for, in one of three states, and
 * the reader is shown the ones the document never touched. Everything on this
 * record is a count or a list of named things at that commit: the reader can
 * re-derive any of it with `thurview graph architecture`. Nothing here grades
 * the code - no scores, no thresholds, no severity. Where a number invites a
 * conclusion, drawing it is the reader's job.
 */
import { globToRegExp } from "./document/compile.js";
import { architecture, isNestedNonMethod, type CodeGraph, type Sym } from "./graph.js";

/** How a file at the pinned commit is accounted for. */
export type FileState =
  /** an anchor in the document points into it: prose covers it */
  | "explained"
  /** only a map node owns it: the reader is told where it sits, not what it does */
  | "placed"
  /** neither: named here and nowhere else */
  | "uncovered";

export interface ClusterCoverage {
  id: string;
  label: string;
  files: number;
  symbols: number;
  /** the most referenced symbols in the cluster, the names a reader knows it by */
  hubs: string[];
  explained: string[];
  placed: string[];
  uncovered: string[];
}

export interface Coverage {
  /** one line stating the bound, shown above the document and printed by publish */
  verdict: string;
  commit: string;
  /** the path glob the explainer is scoped to; `**` is the whole repository */
  scope: string;
  files: {
    total: number;
    /** files in a language the code graph parses */
    inGraph: number;
    /** everything else: config, docs, other languages */
    outsideGraph: number;
  };
  states: { explained: number; placed: number; uncovered: number };
  clusters: ClusterCoverage[];
  /** every file in scope the document never examined, clustered or not */
  uncovered: string[];
  /** in-scope files the code graph cannot read, so they are in no cluster above */
  unclustered: { file: string; state: FileState }[];
  /** references between clusters at the pinned commit */
  links: { from: string; to: string; references: number; bothWays: boolean }[];
  /** names defined in more than one cluster, most-spread first */
  sharedNames: { name: string; clusters: string[]; files: string[] }[];
  sharedNamesTotal: number;
  /** files the graph cannot read, grouped by extension */
  outsideGraph: { extension: string; files: number }[];
  /** map nodes that own files, so an over-broad glob is visible rather than silent */
  owners: { node: string; globs: string[]; files: number }[];
  /** references the graph could not place, and whether its file list was capped */
  unresolved: number;
  truncated: boolean;
}

const MODULE = "<module>";
const SHARED_NAMES_SHOWN = 20;
/** enough for a reader to act on; the counts beside them are never capped */
const FILES_LISTED = 300;

/**
 * Normalise what a reader types as a scope into a glob. A bare path is the
 * directory and everything under it, which is what `thurview explain src/server`
 * means to the person who typed it.
 */
export function scopeGlob(scope: string | undefined): string {
  const s = (scope ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!s || s === "." || s === "**") return "**";
  return /[*?]/.test(s) ? s : `${s}/**`;
}

/** The subset of a graph whose files match `glob`, with the edges that survive it. */
export function scopeGraph(g: CodeGraph, glob: string): CodeGraph {
  if (glob === "**") return g;
  const re = globToRegExp(glob);
  const files = g.files.filter((f) => re.test(f));
  const symbols = g.symbols.filter((s) => re.test(s.file));
  const kept = new Set(symbols.map((s) => s.id));
  return {
    ...g,
    files,
    symbols,
    edges: g.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
  };
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "(none)";
}

export interface CoverageInput {
  commit: string;
  scope: string;
  /** every path at the pinned commit */
  allFiles: string[];
  /** the code graph at that commit, before scoping */
  graph: CodeGraph;
  /** files an anchor's peek points into */
  anchored: Iterable<string>;
  /** map nodes and the globs they own */
  owners: { node: string; globs: string[] }[];
}

/** Account for every file in scope at the pinned commit. */
export function computeCoverage(input: CoverageInput): Coverage {
  const glob = scopeGlob(input.scope);
  const inScope = glob === "**" ? () => true : (f: string) => globToRegExp(glob).test(f);
  const files = input.allFiles.filter(inScope);
  const graph = scopeGraph(input.graph, glob);
  const inGraph = new Set(graph.files);

  const explained = new Set([...input.anchored].filter(inScope));
  const owned = new Map<string, string[]>();
  const owners = input.owners.map(({ node, globs }) => {
    const res = globs.map(globToRegExp);
    const hits = files.filter((f) => res.some((re) => re.test(f)));
    for (const f of hits) owned.set(f, [...(owned.get(f) ?? []), node]);
    return { node, globs, files: hits.length };
  });
  const stateOf = (f: string): FileState =>
    explained.has(f) ? "explained" : owned.has(f) ? "placed" : "uncovered";

  const arch = architecture(graph, graph);
  // Two clusters can share a main directory, and a duplicate label makes the
  // whole page ambiguous: keep them apart by their id.
  const seen = new Map<string, number>();
  for (const c of arch.communities) seen.set(c.label, (seen.get(c.label) ?? 0) + 1);
  const labelOf = (c: { id: string; label: string }) =>
    (seen.get(c.label) ?? 0) > 1 ? `${c.label} (${c.id})` : c.label;
  const clusters: ClusterCoverage[] = arch.communities.map((c) => {
    const buckets: Record<FileState, string[]> = { explained: [], placed: [], uncovered: [] };
    for (const f of c.files) buckets[stateOf(f)].push(f);
    return {
      id: c.id,
      label: labelOf(c),
      files: c.files.length,
      symbols: c.symbols,
      hubs: c.hubs,
      explained: buckets.explained,
      placed: buckets.placed,
      uncovered: buckets.uncovered,
    };
  });

  const both = new Set(arch.edges.map((e) => `${e.from} -> ${e.to}`));
  const links = arch.edges.map((e) => ({
    from: e.from,
    to: e.to,
    references: e.references,
    bothWays: both.has(`${e.to} -> ${e.from}`),
  }));

  const clusterOf = new Map<string, string>();
  for (const c of arch.communities) for (const f of c.files) clusterOf.set(f, c.id);
  // Only definitions a consumer outside the file could name. A definition nested
  // inside another - an `onclick` handler, a local helper - is scoped to its file,
  // so it cannot be the same concept living in two parts, only the same word.
  const byName = new Map<string, Sym[]>();
  for (const s of graph.symbols) {
    if (s.name === MODULE || isNestedNonMethod(s)) continue;
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  const spread: Coverage["sharedNames"] = [];
  for (const [name, syms] of byName) {
    const cs = [...new Set(syms.map((s) => clusterOf.get(s.file)).filter(Boolean))] as string[];
    if (cs.length < 2) continue;
    spread.push({ name, clusters: cs.sort(), files: [...new Set(syms.map((s) => s.file))].sort() });
  }
  spread.sort((a, b) => b.clusters.length - a.clusters.length || a.name.localeCompare(b.name));

  const byExt = new Map<string, number>();
  for (const f of files)
    if (!inGraph.has(f)) {
      const e = extensionOf(f);
      byExt.set(e, (byExt.get(e) ?? 0) + 1);
    }

  const states = { explained: 0, placed: 0, uncovered: 0 };
  for (const f of files) states[stateOf(f)]++;

  const record: Coverage = {
    verdict: "",
    commit: input.commit,
    scope: glob,
    files: {
      total: files.length,
      inGraph: graph.files.length,
      outsideGraph: files.length - graph.files.length,
    },
    states,
    clusters,
    uncovered: files.filter((f) => stateOf(f) === "uncovered").slice(0, FILES_LISTED),
    unclustered: files
      .filter((f) => !inGraph.has(f))
      .slice(0, FILES_LISTED)
      .map((f) => ({ file: f, state: stateOf(f) })),
    links,
    sharedNames: spread.slice(0, SHARED_NAMES_SHOWN),
    sharedNamesTotal: spread.length,
    outsideGraph: [...byExt]
      .map(([extension, n]) => ({ extension, files: n }))
      .sort((a, b) => b.files - a.files || a.extension.localeCompare(b.extension)),
    owners: owners.sort((a, b) => b.files - a.files || a.node.localeCompare(b.node)),
    unresolved: input.graph.unresolved,
    truncated: input.graph.truncated,
  };
  record.verdict = coverageVerdict(record);
  return record;
}

/** One line stating coverage, for the panel above the document and for the CLI. */
function coverageVerdict(c: Coverage): string {
  const { explained, placed, uncovered } = c.states;
  const where = c.scope === "**" ? "the repository" : c.scope;
  const parts = [
    `${c.files.total} file${c.files.total === 1 ? "" : "s"} at ${c.commit.slice(0, 12)} in ${where}`,
    `${explained} anchored in the document`,
    `${placed} placed on the map only`,
    `${uncovered} not examined`,
  ];
  const tail =
    c.files.outsideGraph > 0
      ? ` ${c.files.outsideGraph} of them are outside the languages the code graph reads.`
      : "";
  return `${parts.join(", ")}.${tail}`;
}
