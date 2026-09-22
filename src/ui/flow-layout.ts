// Where a user flow's boxes and arrows go, apart from drawing them, so the
// geometry can be checked without a browser.
import type { Block } from "../document/compile.js";

export type Flow = Extract<Block, { type: "flow" }>;

export interface FlowBox {
  x: number;
  y: number;
  cx: number;
  li: number;
}

export interface FlowEdge {
  edge: Flow["edges"][number];
  d: string;
  /** an edge that climbs to an earlier row: a loop, drawn dashed */
  back: boolean;
  label: { x: number; y: number; at: string };
}

export const boxW = 210;
export const boxH = 46;
const gapX = 40;
const gapY = 58;
const pad = 14;
// `.diagram svg` stretches to the column, so a narrow viewBox magnifies the
// type: a two-wide flow would draw its 12px labels at nearer 17. A floor on
// the viewBox keeps a small flow close to 1:1 and centres it in the frame.
const minW = 700;

/**
 * Layers come from a walk forward from the first step, so an edge that points
 * back to a layer already placed - a retry loop, which is what a real journey
 * does - is routed down a lane on the right instead of crossing the boxes.
 */
export function layoutFlow(b: Flow): {
  width: number;
  height: number;
  at: (id: string) => FlowBox;
  edges: FlowEdge[];
} {
  const layer = new Map<string, number>([[b.steps[0]!.id, 0]]);
  const queue = [b.steps[0]!.id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of b.edges)
      if (e.from === cur && !layer.has(e.to)) {
        layer.set(e.to, layer.get(cur)! + 1);
        queue.push(e.to);
      }
  }
  const rows: string[][] = [];
  for (const s of b.steps) {
    const li = layer.get(s.id)!;
    (rows[li] ??= []).push(s.id);
  }
  // One lane per loop, so two retries never share a vertical run. The shorter
  // a loop, the nearer the boxes its lane, so a loop nested in another stays inside it.
  const span = (e: Flow["edges"][number]) => layer.get(e.from)! - layer.get(e.to)!;
  const loops = b.edges.filter((e) => span(e) >= 0).sort((p, q) => span(p) - span(q));
  const lanes = loops.length > 0;
  const widest = Math.max(...rows.map((r) => r.length));
  const laneGap = 18;
  const lane = lanes ? 34 + (loops.length - 1) * laneGap : 0;
  // A lane edge turns in the empty bands above and below a row, so the first
  // and last rows need a band of their own once one exists.
  const band = lanes ? gapY / 2 : 0;
  const width = Math.max(minW, pad * 2 + widest * boxW + (widest - 1) * gapX + lane);
  const height = pad * 2 + band * 2 + rows.length * boxH + (rows.length - 1) * gapY;
  const at = (id: string): FlowBox => {
    const li = layer.get(id)!;
    const row = rows[li]!;
    const spanW = row.length * boxW + (row.length - 1) * gapX;
    const x = pad + (width - lane - pad * 2 - spanW) / 2 + row.indexOf(id) * (boxW + gapX);
    return { x, y: pad + band + li * (boxH + gapY), cx: x + boxW / 2, li };
  };

  const edges = b.edges.map((edge): FlowEdge => {
    const from = at(edge.from);
    const to = at(edge.to);
    // Only an edge that climbs is a loop. One inside a row is still forward,
    // and dashing it would tell the reader the journey goes back when it does not.
    const back = to.li < from.li;
    if (to.li > from.li) {
      const mid = from.y + boxH + (to.y - from.y - boxH) / 2;
      return {
        edge,
        back,
        d: `M${from.cx},${from.y + boxH} V${mid} H${to.cx} V${to.y - 4}`,
        label: { x: (from.cx + to.cx) / 2 + 6, y: mid - 5, at: "middle" },
      };
    }
    // Out through the band below this row, up the lane, and back in through
    // the band above the target. Every horizontal run is then in empty space,
    // so the edge never crosses a box standing beside either of its ends.
    const laneX = width - lane + 17 + loops.indexOf(edge) * laneGap;
    const out = from.y + boxH + gapY / 2;
    const into = to.y - gapY / 2;
    return {
      edge,
      back,
      d: `M${from.cx},${from.y + boxH} V${out} H${laneX} V${into} H${to.cx} V${to.y - 4}`,
      label: { x: laneX - 6, y: (out + into) / 2, at: "end" },
    };
  });
  return { width, height, at, edges };
}
