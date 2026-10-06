/**
 * What an explainer examined, and what it did not.
 *
 * A review is bounded by its diff, so its own scope is the reader's proof that
 * nothing was skipped. A codebase has no such bound: prose over a whole repo
 * either runs unreadably long or quietly leaves most of the system out, and an
 * explanation that leaves things out silently is misleading about architecture.
 *
 * So coverage is DERIVED here rather than claimed in prose, from what the agent
 * did that publish can check: the files its anchors point into, the files its
 * map's globs own, and the files the searches it recorded match when publish
 * re-runs them at the pinned commit. Every file in scope at that commit is
 * accounted for in one of four states, and the reader is shown the ones nothing
 * reached. Everything on this record is a count or a list of named things at
 * that commit, which the reader can re-derive with `git ls-tree` and `git grep`.
 * Nothing here grades the code - no scores, no thresholds, no severity.
 */
import { globToRegExp } from "./document/compile.js";

/** How a file at the pinned commit is accounted for. */
export type FileState =
  /** an anchor in the document points into it: prose covers it */
  | "explained"
  /** only a map node owns it: the reader is told where it sits, not what it does */
  | "placed"
  /** only a recorded search matched it: the agent saw lines of it, the document says nothing */
  | "searched"
  /** none of the above: named here and nowhere else */
  | "uncovered";

/** One search the agent recorded, as publish re-ran it at the pinned commit. */
export interface SearchRecord {
  key: string;
  pattern: string;
  /** the git pathspecs it searched under; empty is the whole commit */
  paths: string[];
  why?: string;
  /** matching lines, over every file it matched */
  hits: number;
  /** the files it matched, in scope or not */
  files: string[];
}

export interface ClusterCoverage {
  id: string;
  /** the directory under the scope; the scope's own (`src/`), or `.`, for the files directly in it */
  label: string;
  files: number;
  explained: string[];
  placed: string[];
  searched: string[];
  uncovered: string[];
}

export interface Coverage {
  /** one line stating the bound, shown above the document and printed by publish */
  verdict: string;
  commit: string;
  /** the path glob the explainer is scoped to; `**` is the whole repository */
  scope: string;
  files: { total: number };
  states: Record<FileState, number>;
  /** the files in scope grouped by the directory under the scope, largest first */
  clusters: ClusterCoverage[];
  /** every file in scope nothing reached */
  uncovered: string[];
  /** what the agent searched, with what each search matched at the pinned commit */
  searches: SearchRecord[];
  /** map nodes that own files, so an over-broad glob is visible rather than silent */
  owners: { node: string; globs: string[]; files: number }[];
}

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

/** The fixed directory a scope glob starts with, so a part is named under it. */
function scopeRoot(glob: string): string {
  const parts = glob.split("/");
  const fixed = parts.slice(
    0,
    parts.findIndex((p) => /[*?[]/.test(p)),
  );
  return fixed.length ? `${fixed.join("/")}/` : "";
}

export interface CoverageInput {
  commit: string;
  scope: string;
  /** every path at the pinned commit */
  allFiles: string[];
  /** files an anchor's peek points into */
  anchored: Iterable<string>;
  /** map nodes and the globs they own */
  owners: { node: string; globs: string[] }[];
  /** the agent's searches, re-run at the pinned commit */
  searches: SearchRecord[];
}

/** Account for every file in scope at the pinned commit. */
export function computeCoverage(input: CoverageInput): Coverage {
  const glob = scopeGlob(input.scope);
  const inScope = glob === "**" ? () => true : (f: string) => globToRegExp(glob).test(f);
  const files = input.allFiles.filter(inScope);

  const explained = new Set([...input.anchored].filter(inScope));
  const owned = new Set<string>();
  const owners = input.owners.map(({ node, globs }) => {
    const res = globs.map(globToRegExp);
    const hits = files.filter((f) => res.some((re) => re.test(f)));
    for (const f of hits) owned.add(f);
    return { node, globs, files: hits.length };
  });
  const searched = new Set(input.searches.flatMap((s) => s.files));
  const stateOf = (f: string): FileState =>
    explained.has(f)
      ? "explained"
      : owned.has(f)
        ? "placed"
        : searched.has(f)
          ? "searched"
          : "uncovered";

  const root = scopeRoot(glob);
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const rest = f.startsWith(root) ? f.slice(root.length) : f;
    // files directly in a scoped directory are named by it, with its slash so a
    // subdirectory of the same name stays apart; directly in the repository, `.`
    const dir = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : root || ".";
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const clusters: ClusterCoverage[] = [...byDir]
    .map(([dir, fs]) => {
      const buckets: Record<FileState, string[]> = {
        explained: [],
        placed: [],
        searched: [],
        uncovered: [],
      };
      for (const f of fs) buckets[stateOf(f)].push(f);
      return { id: dir, label: dir, files: fs.length, ...buckets };
    })
    .sort((a, b) => b.files - a.files || a.label.localeCompare(b.label));

  const states: Record<FileState, number> = { explained: 0, placed: 0, searched: 0, uncovered: 0 };
  for (const f of files) states[stateOf(f)]++;

  const record: Coverage = {
    verdict: "",
    commit: input.commit,
    scope: glob,
    files: { total: files.length },
    states,
    clusters,
    uncovered: files.filter((f) => stateOf(f) === "uncovered").slice(0, FILES_LISTED),
    searches: input.searches.map((s) => ({ ...s, files: s.files.slice(0, FILES_LISTED) })),
    owners: owners.sort((a, b) => b.files - a.files || a.node.localeCompare(b.node)),
  };
  record.verdict = coverageVerdict(record);
  return record;
}

/** One line stating coverage, for the panel above the document and for the CLI. */
function coverageVerdict(c: Coverage): string {
  const { explained, placed, searched, uncovered } = c.states;
  const where = c.scope === "**" ? "the repository" : c.scope;
  return [
    `${c.files.total} file${c.files.total === 1 ? "" : "s"} at ${c.commit.slice(0, 12)} in ${where}`,
    `${explained} anchored in the document`,
    `${placed} placed on the map only`,
    `${searched} matched by a recorded search only`,
    `${uncovered} not examined`,
  ]
    .join(", ")
    .concat(".");
}
