import { h, svg } from "./dom.js";
import { state } from "./state.js";
import type { Block, CompiledDocument } from "../document/compile.js";
import { openAnchorPeek } from "./code.js";
import { popover } from "./dom.js";
import { boxH, boxW, layoutFlow, type Flow } from "./flow-layout.js";

type Seq = Extract<Block, { type: "sequence" }>;
type Stack = Extract<Block, { type: "callstack" }>;
type Db = Extract<Block, { type: "database" }>;

function openAnchor(id: string): void {
  const a = state.data?.document?.anchors[id];
  if (a) openAnchorPeek(a);
}

export function sequenceDiagram(b: Seq): HTMLElement {
  // Labels are mono at a known size, so their width is a character count. A
  // long actor name or message wraps rather than widening the drawing past
  // the column; every box and column then grows to hold what it wraps to.
  const charW = 12 * 0.605;
  const lineH = 15;
  const wrap = (text: string, room: number) => {
    const max = Math.max(8, Math.floor(room / charW));
    const lines: string[] = [];
    for (const word of text.split(" ")) {
      const last = lines.length - 1;
      if (last >= 0 && lines[last]!.length + 1 + word.length <= max) lines[last] += ` ${word}`;
      else lines.push(word);
    }
    return lines;
  };
  const widest = (lines: string[]) => Math.max(...lines.map((l) => l.length)) * charW;
  const names = b.actors.map((a) => wrap(a.label, 20 * charW));
  const nameLines = Math.max(...names.map((l) => l.length));
  const boxH = 13 + nameLines * lineH;
  const top = 6 + boxH + 10;
  const boxes = names.map((l) => Math.max(120, widest(l) + 20));
  const cols = boxes.map((w) => Math.max(150, w + 16));
  const centres = cols.map((w, i) => cols.slice(0, i).reduce((s, c) => s + c, 0) + w / 2);
  const x = (id: string) => centres[b.actors.findIndex((a) => a.id === id)]!;
  // A label starts just past the arrow's left end, wraps to the arrow's span,
  // and stacks upwards from it, so it never hangs off the lifeline it leaves.
  let y = top;
  const rows = b.messages.map((m, i) => {
    const x1 = x(m.from);
    const x2 = x(m.to);
    const self = x1 === x2;
    const start = self ? x1 + 36 : Math.min(x1, x2) + 8;
    const lines = wrap(`${i + 1}. ${m.label}`, Math.max(180, Math.abs(x2 - x1) - 16));
    y += 20 + lines.length * lineH;
    return { x1, x2, self, start, lines, y, end: start + widest(lines) };
  });
  const width = Math.ceil(
    Math.max(
      320,
      cols.reduce((s, c) => s + c, 0),
      ...rows.map((r) => r.end + 12),
    ),
  );
  const height = y + 24;
  // Drawn at its own size, and shrunk only as far as keeps the text readable;
  // a narrower column scrolls the frame rather than the text going to specks.
  const el = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "seq",
    style: `max-width:${width}px;min-width:${Math.ceil(width * 0.9)}px`,
  });
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
  // One tspan per wrapped line, the last on `baseline` and the rest above it.
  const tspans = (at: number, baseline: number, text: string[]) =>
    text.map((l, i) => svg("tspan", { x: at, y: baseline - (text.length - 1 - i) * lineH }, l));
  b.actors.forEach((_, i) => {
    const cx = centres[i]!;
    const w = boxes[i]!;
    const name = names[i]!;
    const g = svg("g", { class: "actor" });
    g.appendChild(svg("rect", { x: cx - w / 2, y: 6, width: w, height: boxH, rx: 6 }));
    // Centred in the box however many lines this name wrapped to.
    const baseline = 6 + (boxH + name.length * lineH) / 2 - 4;
    g.appendChild(svg("text", { "text-anchor": "middle" }, ...tspans(cx, baseline, name)));
    g.appendChild(svg("line", { class: "life", x1: cx, y1: 6 + boxH, x2: cx, y2: height - 6 }));
    el.appendChild(g);
  });
  b.messages.forEach((m, i) => {
    const { x1, x2, self, start, y } = rows[i]!;
    const g = svg("g", { class: "msg" });
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
    const label = svg("text", {}, ...tspans(start, y - 6, rows[i]!.lines));
    const open = (at: { x: number; y: number }) => {
      if (m.anchor) openAnchor(m.anchor);
      else if (m.code)
        popover(
          h(
            "div",
            { class: "def-popover" },
            h("pre", { style: { margin: "0", border: "none" } }, m.code.text),
          ),
          at,
        );
    };
    label.addEventListener("click", (e) => open({ x: e.pageX, y: e.pageY + 8 }));
    if (m.anchor || m.code) {
      // Opening code is what a message is for, so it answers the keyboard too.
      label.setAttribute("role", "button");
      label.setAttribute("tabindex", "0");
      label.addEventListener("keydown", (e) => {
        const k = (e as KeyboardEvent).key;
        if (k !== "Enter" && k !== " ") return;
        e.preventDefault();
        const r = label.getBoundingClientRect();
        open({ x: r.left + window.scrollX, y: r.bottom + window.scrollY + 8 });
      });
    }
    g.appendChild(label);
    el.appendChild(g);
  });
  return h(
    "div",
    { class: "diagram" },
    h("div", { class: "dhead" }, b.label),
    h("div", { class: "seq-scroll" }, el),
  );
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
 * A user flow, laid out top to bottom in layers by `layoutFlow`. The geometry
 * is computed in the browser rather than at compile time for the same reason
 * `sequence`'s is: the compiler's job is refusing a flow it cannot draw, not
 * deciding where the boxes go.
 */
export function flowDiagram(b: Flow, doc: CompiledDocument): HTMLElement {
  // The labels are mono at a known size, so a character budget is enough to
  // keep one inside its box; the whole text stays in the tooltip.
  const fit = (text: string, room: number, px: number) => {
    const max = Math.floor(room / (px * 0.605));
    return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
  };
  const { width, height, at, edges } = layoutFlow(b);

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

  for (const { edge, d, back, label } of edges) {
    const g = svg("g", { class: back ? "edge back" : "edge" });
    g.appendChild(svg("path", { d, fill: "none", "marker-end": "url(#flow-arr)" }));
    if (edge.case)
      g.appendChild(svg("text", { x: label.x, y: label.y, "text-anchor": label.at }, edge.case));
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
