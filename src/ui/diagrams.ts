import { h, svg } from "./dom.js";
import { state } from "./state.js";
import type { Block, CompiledDocument } from "../document/compile.js";
import { openAnchorPeek } from "./code.js";
import { popover } from "./dom.js";

type Seq = Extract<Block, { type: "sequence" }>;
type Stack = Extract<Block, { type: "callstack" }>;
type Db = Extract<Block, { type: "database" }>;
type Flow = Extract<Block, { type: "flow" }>;

function openAnchor(id: string): void {
  const a = state.data?.document?.anchors[id];
  if (a) openAnchorPeek(a);
}

export function sequenceDiagram(b: Seq): HTMLElement {
  const colW = 170;
  const top = 44;
  const rowH = 34;
  const n = b.actors.length;
  const width = Math.max(colW * n, 320);
  const height = top + rowH * (b.messages.length + 1) + 10;
  const el = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "seq" });
  el.appendChild(
    svg(
      "defs",
      {},
      svg(
        "marker",
        {
          id: "arr",
          viewBox: "0 0 10 10",
          refX: "9",
          refY: "5",
          markerWidth: "7",
          markerHeight: "7",
          orient: "auto",
        },
        svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "currentColor" }),
      ),
    ),
  );
  const x = (id: string) => b.actors.findIndex((a) => a.id === id) * colW + colW / 2;
  b.actors.forEach((a, i) => {
    const cx = i * colW + colW / 2;
    const g = svg("g", { class: "actor" });
    g.appendChild(svg("rect", { x: cx - 70, y: 6, width: 140, height: 28, rx: 6 }));
    g.appendChild(svg("text", { x: cx, y: 25, "text-anchor": "middle" }, a.label));
    g.appendChild(svg("line", { class: "life", x1: cx, y1: 34, x2: cx, y2: height - 6 }));
    el.appendChild(g);
  });
  b.messages.forEach((m, i) => {
    const y = top + rowH * (i + 1);
    const x1 = x(m.from);
    const x2 = x(m.to);
    const g = svg("g", { class: "msg" });
    const self = x1 === x2;
    if (self) {
      g.appendChild(
        svg("path", {
          d: `M${x1},${y - 10} h30 v20 h-30`,
          fill: "none",
          stroke: "currentColor",
          "marker-end": "url(#arr)",
        }),
      );
    } else {
      g.appendChild(svg("line", { x1, y1: y, x2: x2 + (x2 > x1 ? -4 : 4), y2: y }));
    }
    const label = svg(
      "text",
      { x: self ? x1 + 36 : (x1 + x2) / 2, y: y - 6, "text-anchor": self ? "start" : "middle" },
      `${i + 1}. ${m.label}`,
    );
    label.addEventListener("click", (e) => {
      if (m.anchor) openAnchor(m.anchor);
      else if (m.code)
        popover(
          h(
            "div",
            { class: "def-popover" },
            h("pre", { style: { margin: "0", border: "none" } }, m.code.text),
          ),
          { x: e.pageX, y: e.pageY + 8 },
        );
    });
    g.appendChild(label);
    el.appendChild(g);
  });
  return h("div", { class: "diagram" }, h("div", { class: "dhead" }, b.label), el);
}

export function callstackDiff(b: Stack, doc: CompiledDocument): HTMLElement {
  const rows = b.rows.map((r, i) => {
    const a = doc.anchors[r.anchor];
    return h(
      "div",
      { class: `row ${r.kind}`, title: r.reason ?? "", onclick: () => openAnchor(r.anchor) },
      h("span", { class: "sign" }, r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "),
      h("span", { style: { width: `${i * 14}px`, display: "inline-block" } }),
      r.calls ? h("span", { class: "calls" }, "≈ ") : null,
      h("span", null, a?.title ?? r.anchor),
      a?.peek
        ? h(
            "span",
            { class: "muted", style: { marginLeft: "auto" } },
            `${a.peek.file}:${a.peek.from}`,
          )
        : null,
    );
  });
  return h(
    "div",
    { class: "diagram callstack" },
    h("div", { class: "dhead" }, b.title ?? "Call stack"),
    h("div", { style: { padding: "6px 0" } }, rows),
  );
}

export function databaseLens(b: Db, doc: CompiledDocument): HTMLElement {
  let active = 0;
  const tabs = h("div", { class: "uc-tabs" });
  const body = h("div", { class: "body" });
  const draw = () => {
    tabs.innerHTML = "";
    b.usecases.forEach((uc, i) =>
      tabs.appendChild(
        h(
          "button",
          {
            class: `small ${i === active ? "active" : ""}`,
            onclick: () => {
              active = i;
              draw();
            },
          },
          uc.label,
        ),
      ),
    );
    const uc = b.usecases[active]!;
    body.innerHTML = "";
    const touched = new Map<string, Set<string>>();
    for (const op of uc.ops) {
      const [s, c, f] = op.store.split(".");
      const key = `${s}.${c}`;
      if (!touched.has(key)) touched.set(key, new Set());
      if (f) touched.get(key)!.add(f);
    }
    const actorIds = [...new Set(uc.ops.map((o) => o.actor))];
    body.appendChild(
      h(
        "div",
        { class: "actors" },
        actorIds.map((id) => h("div", { class: "actor" }, doc.actors[id]?.label ?? id)),
      ),
    );
    const stores = h("div", null);
    for (const sid of b.stores) {
      const s = doc.stores[sid];
      if (!s) continue;
      const colls = s.tables ?? s.documents ?? {};
      stores.appendChild(
        h(
          "div",
          { class: "store" },
          h("div", { class: "sname" }, s.label, " ", h("span", { class: "badge" }, s.kind)),
          Object.entries(colls).map(([cid, c]) => {
            const hit = touched.get(`${sid}.${cid}`);
            return h(
              "div",
              { class: `table ${hit ? "hit" : ""}` },
              h("div", { class: "tname" }, c.label ?? cid),
              h(
                "div",
                { class: "cols" },
                Object.entries(c.schema).map(([f, def]) =>
                  h(
                    "span",
                    { class: hit?.has(f) ? "hit" : "" },
                    `${f}${def.pk ? "*" : ""}:${def.type} `,
                  ),
                ),
              ),
            );
          }),
        ),
      );
    }
    body.appendChild(stores);
  };
  draw();
  const ops = h("div", { class: "ops" });
  const drawOps = () => {
    ops.innerHTML = "";
    const uc = b.usecases[active]!;
    if (uc.summary) ops.appendChild(h("div", { class: "muted" }, uc.summary));
    for (const op of uc.ops) {
      ops.appendChild(
        h(
          "div",
          { class: `op ${op.op}`, onclick: () => openAnchor(op.anchor) },
          h(
            "span",
            { class: "dir" },
            op.op === "read"
              ? `${op.store} → ${doc.actors[op.actor]?.label ?? op.actor}`
              : `${doc.actors[op.actor]?.label ?? op.actor} → ${op.store}`,
          ),
          h("span", null, op.label),
        ),
      );
    }
  };
  drawOps();
  tabs.addEventListener("click", drawOps);
  return h(
    "div",
    { class: "diagram dblens" },
    h("div", { class: "dhead" }, b.title ?? "Storage"),
    tabs,
    body,
    ops,
  );
}

/**
 * A user flow, laid out top to bottom in layers.
 *
 * Layers come from a walk forward from the first step, so an edge that points
 * back to a layer already placed - a retry loop, which is what a real journey
 * does - is routed down the right-hand lane instead of crossing the boxes. The
 * geometry is computed here rather than at compile time for the same reason
 * `sequence`'s is: the compiler's job is refusing a flow it cannot draw, not
 * deciding where the boxes go.
 */
export function flowDiagram(b: Flow, doc: CompiledDocument): HTMLElement {
  const boxW = 210;
  const boxH = 46;
  const gapX = 40;
  const gapY = 58;
  const pad = 14;
  // `.diagram svg` stretches to the column, so a narrow viewBox magnifies the
  // type: a two-wide flow would draw its 12px labels at nearer 17. A floor on
  // the viewBox keeps a small flow close to 1:1 and centres it in the frame.
  const minW = 700;
  // The labels are mono at a known size, so a character budget is enough to
  // keep one inside its box; the whole text stays in the tooltip.
  const fit = (text: string, room: number, px: number) => {
    const max = Math.floor(room / (px * 0.605));
    return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
  };

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
  const lanes = b.edges.some((e) => layer.get(e.to)! <= layer.get(e.from)!);
  const widest = Math.max(...rows.map((r) => r.length));
  const lane = lanes ? 34 : 0;
  // A lane edge turns in the empty bands above and below a row, so the first
  // and last rows need a band of their own once one exists.
  const band = lanes ? gapY / 2 : 0;
  const width = Math.max(minW, pad * 2 + widest * boxW + (widest - 1) * gapX + lane);
  const height = pad * 2 + band * 2 + rows.length * boxH + (rows.length - 1) * gapY;
  const at = (id: string) => {
    const li = layer.get(id)!;
    const row = rows[li]!;
    const spanW = row.length * boxW + (row.length - 1) * gapX;
    const x = pad + (width - lane - pad * 2 - spanW) / 2 + row.indexOf(id) * (boxW + gapX);
    return { x, y: pad + band + li * (boxH + gapY), cx: x + boxW / 2, li };
  };

  const el = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "flow" });
  el.appendChild(
    svg(
      "defs",
      {},
      svg(
        "marker",
        {
          id: "flow-arr",
          viewBox: "0 0 10 10",
          refX: "9",
          refY: "5",
          markerWidth: "7",
          markerHeight: "7",
          orient: "auto",
        },
        svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "currentColor" }),
      ),
    ),
  );

  for (const e of b.edges) {
    const from = at(e.from);
    const to = at(e.to);
    // Only an edge that climbs is a loop. One inside a row is still forward,
    // and dashing it would tell the reader the journey goes back when it does not.
    const g = svg("g", { class: to.li < from.li ? "edge back" : "edge" });
    let d: string;
    let label: { x: number; y: number; at: string };
    if (to.li > from.li) {
      const mid = from.y + boxH + (to.y - from.y - boxH) / 2;
      d = `M${from.cx},${from.y + boxH} V${mid} H${to.cx} V${to.y - 4}`;
      label = { x: (from.cx + to.cx) / 2 + 6, y: mid - 5, at: "middle" };
    } else {
      // Out through the band below this row, up the lane, and back in through
      // the band above the target. Every horizontal run is then in empty space,
      // so the edge never crosses a box standing beside either of its ends.
      const laneX = width - lane / 2;
      const out = from.y + boxH + gapY / 2;
      const into = to.y - gapY / 2;
      d = `M${from.cx},${from.y + boxH} V${out} H${laneX} V${into} H${to.cx} V${to.y - 4}`;
      label = { x: laneX - 6, y: (out + into) / 2, at: "end" };
    }
    g.appendChild(svg("path", { d, fill: "none", "marker-end": "url(#flow-arr)" }));
    if (e.case)
      g.appendChild(svg("text", { x: label.x, y: label.y, "text-anchor": label.at }, e.case));
    el.appendChild(g);
  }

  for (const s of b.steps) {
    const { x, y, cx } = at(s.id);
    const g = svg("g", {
      class: `step${s.decision ? " decision" : ""}${s.anchor ? "" : " plain"}`,
    });
    // A decision is cut at the sides so it reads as one at a glance while still
    // holding a sentence; a diamond wide enough for the text would dwarf the row.
    g.appendChild(
      s.decision
        ? svg("path", {
            d: `M${x + 16},${y} H${x + boxW - 16} L${x + boxW},${y + boxH / 2} L${x + boxW - 16},${y + boxH} H${x + 16} L${x},${y + boxH / 2} Z`,
          })
        : svg("rect", { x, y, width: boxW, height: boxH, rx: 6 }),
    );
    // A decision is cut in at both ends, so it has less room for text than a step.
    const room = boxW - (s.decision ? 44 : 20);
    const actor = s.actor ? (doc.actors[s.actor]?.label ?? s.actor) : null;
    if (actor)
      g.appendChild(
        svg(
          "text",
          { class: "who", x: cx, y: y + 17, "text-anchor": "middle" },
          fit(actor, room, 10.5),
        ),
      );
    g.appendChild(
      svg(
        "text",
        { x: cx, y: actor ? y + 33 : y + boxH / 2 + 4, "text-anchor": "middle" },
        fit(s.label, room, 12),
      ),
    );
    g.appendChild(svg("title", {}, s.anchor ? `${s.label} — ${s.anchor}` : s.label));
    if (s.anchor) {
      // The only way to open code from a flow, so it answers the keyboard as
      // well as the mouse rather than announcing a button nothing can reach.
      const open = () => openAnchor(s.anchor!);
      g.setAttribute("role", "button");
      g.setAttribute("tabindex", "0");
      g.addEventListener("click", open);
      g.addEventListener("keydown", (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          open();
        }
      });
    }
    el.appendChild(g);
  }
  return h("div", { class: "diagram" }, h("div", { class: "dhead" }, b.label), el);
}
