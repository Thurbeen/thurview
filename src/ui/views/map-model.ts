// The reading order behind the Map tab. The Files tab already answers "which
// lines changed"; the map answers "which parts of the system did they land in,
// and what sits next to those parts". Everything here exists to put the parts
// that need attention in front of the reader before the ones that do not, so
// the view itself only has to draw the order it is given.
import type { CompiledMap } from "../../document/compile.js";
import type { MapEdge, MapNode } from "../../document/schema.js";

export type NodeStatus = "added" | "removed" | "changed" | "";
export type MapItem = MapNode & { status: NodeStatus };
export type FilesByNode = Record<string, string[]>;

export function parentOf(id: string): string {
  return id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "";
}

/** Every node the reader can meet: head, plus the ones the change removed. */
export function collect(map: CompiledMap): Map<string, MapItem> {
  const all = new Map<string, MapItem>();
  for (const n of map.head.nodes)
    all.set(n.id, {
      ...n,
      status: map.diff.added.includes(n.id)
        ? "added"
        : map.diff.changed.includes(n.id)
          ? "changed"
          : "",
    });
  for (const id of map.diff.removed) {
    const n = (map.base?.nodes ?? []).find((x) => x.id === id);
    if (n) all.set(id, { ...n, status: "removed" });
  }
  return all;
}

/** Nodes with a status somewhere below `id`: the change a closed node hides. */
export function changedInside(all: Map<string, MapItem>, id: string): number {
  let n = 0;
  for (const item of all.values()) if (item.id.startsWith(id + ".") && item.status) n++;
  return n;
}

/** True when this node, or anything under it, is part of the change. */
export function touched(all: Map<string, MapItem>, item: MapItem): boolean {
  return !!item.status || changedInside(all, item.id) > 0;
}

/**
 * The children of `parent` in reading order: what the change touched first,
 * heaviest first, then the untouched context in the order the author wrote it.
 */
export function childrenOf(
  all: Map<string, MapItem>,
  parent: string,
  filesByNode: FilesByNode,
): MapItem[] {
  const kids = [...all.values()].filter((n) => parentOf(n.id) === parent);
  const weight = (n: MapItem) => (filesByNode[n.id]?.length ?? 0) + changedInside(all, n.id);
  return kids
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const t = Number(touched(all, b.n)) - Number(touched(all, a.n));
      if (t) return t;
      const w = weight(b.n) - weight(a.n);
      return w || a.i - b.i;
    })
    .map((x) => x.n);
}

/**
 * Where to start reading. The most specific part the change landed in — a
 * parent only holds the diff of its children, so it is never the answer while
 * a leaf carries one. Null when the change touched no part of the map.
 */
export function routeIn(all: Map<string, MapItem>, filesByNode: FilesByNode): MapItem | null {
  const changed = [...all.values()].filter((n) => n.status);
  const hasChild = (id: string) => [...all.keys()].some((k) => parentOf(k) === id);
  const leaves = changed.filter((n) => !hasChild(n.id));
  const pool = leaves.length ? leaves : changed;
  let best: MapItem | null = null;
  let bestFiles = -1;
  for (const n of pool) {
    const files = filesByNode[n.id]?.length ?? 0;
    if (files > bestFiles) {
      best = n;
      bestFiles = files;
    }
  }
  return best;
}

export interface Neighbour {
  dir: "out" | "in";
  other: string;
  label?: string;
}

/** What a change to `id` can reach, and what reaches it. */
export function neighboursOf(map: CompiledMap, id: string): Neighbour[] {
  const out: Neighbour[] = [];
  const into: Neighbour[] = [];
  for (const e of allEdges(map)) {
    if (e.from === id)
      out.push({ dir: "out", other: e.to, ...(e.label ? { label: e.label } : {}) });
    if (e.to === id)
      into.push({ dir: "in", other: e.from, ...(e.label ? { label: e.label } : {}) });
  }
  return [...out, ...into];
}

/** Head edges, plus the ones only the base had, so a removed link still shows. */
export function allEdges(map: CompiledMap): MapEdge[] {
  const edges = [...map.head.edges];
  for (const e of map.base?.edges ?? [])
    if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);
  return edges;
}

export interface RankedEdge {
  edge: MapEdge;
  touchesChange: boolean;
}

/**
 * Edges ordered by how much of the change they carry: both ends changed first,
 * then one end, then the rest. A link between two changed parts is where a
 * contract can have moved on only one side of it.
 */
export function rankEdges(edges: MapEdge[], all: Map<string, MapItem>): RankedEdge[] {
  const hot = (id: string) => (all.get(id)?.status ? 1 : 0);
  return edges
    .map((edge, i) => ({ edge, i, ends: hot(edge.from) + hot(edge.to) }))
    .sort((a, b) => b.ends - a.ends || a.i - b.i)
    .map(({ edge, ends }) => ({ edge, touchesChange: ends > 0 }));
}
