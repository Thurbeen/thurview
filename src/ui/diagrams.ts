import { h, svg } from "./dom.js";
import { state } from "./state.js";
import type { Block, CompiledDocument } from "../document/compile.js";
import { openAnchorPeek } from "./code.js";
import { popover } from "./dom.js";

type Seq = Extract<Block, { type: "sequence" }>;
type Stack = Extract<Block, { type: "callstack" }>;
type Db = Extract<Block, { type: "database" }>;

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
