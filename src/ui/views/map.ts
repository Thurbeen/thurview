import { h, append, popover } from "../dom.js";
import { state, navigate, threadsFor, kind } from "../state.js";
import { openAnchorPeek } from "../code.js";
import { commentPopover, threadPinRow } from "../threads.js";
import {
  allEdges,
  changedInside,
  childrenOf,
  collect,
  neighboursOf,
  parentOf,
  rankEdges,
  routeIn,
  touched,
  type MapItem,
} from "./map-model.js";
import type { MapEdge } from "../../document/schema.js";

const statusClass = (s: string) => (s === "added" ? "ok" : s === "removed" ? "del" : "warn");

export function renderMap(root: HTMLElement): void {
  const map = state.data?.map;
  // A map with no nodes is the same to the reader as no map at all, and the
  // reason for both is worth saying: an absent map is a claim, not a gap.
  const explainer = kind() === "explainer";
  if (!map || !map.head.nodes.length) {
    append(root, [
      explainer
        ? h(
            "div",
            { class: "empty-state" },
            h("p", null, "No map in this explainer."),
            h(
              "p",
              null,
              "The map is where an explainer carries breadth: it places the parts the prose ",
              "had no room for. Without one, every file the document does not anchor counts ",
              "as not examined on the Coverage tab.",
            ),
          )
        : h(
            "div",
            { class: "empty-state" },
            h("p", null, "No map in this review."),
            h(
              "p",
              null,
              "The map places a change inside the system and shows what sits next to it. ",
              "A change that lands in one place, where the Files tab already answers that, ships without one.",
            ),
          ),
    ]);
    return;
  }
  const headNodes = new Map(map.head.nodes.map((n) => [n.id, n]));
  const baseNodes = new Map((map.base?.nodes ?? []).map((n) => [n.id, n]));
  const all = collect(map);
  const edges = allEdges(map);
  const route = routeIn(all, map.filesByNode);

  const selected = state.params.get("node") ?? "";
  const hasChildren = (id: string) => [...all.keys()].some((k) => parentOf(k) === id);
  let level =
    selected && all.has(selected) ? (hasChildren(selected) ? selected : parentOf(selected)) : "";

  const canvas = h("div", { class: "map-canvas" });
  const side = h("div", { class: "map-side" });
  root.appendChild(h("div", { class: "map-layout" }, canvas, side));

  const openLevel = (id: string) => {
    level = id;
    draw();
  };

  // The lead-in. A reader who opens this tab cold has no idea why it is here,
  // so it says what the map answers that the diff cannot, and hands them one
  // place to start rather than a board of equal boxes.
  const intro = () => {
    if (explainer)
      return h(
        "div",
        { class: "map-intro" },
        h("h2", null, "The parts of the system"),
        h(
          "p",
          null,
          "The document carries depth on the parts it selected; this carries breadth over the",
          " rest — what the parts are, what they own, and what they connect to at the pinned",
          " commit. Open a part to see its files, its code and its neighbours.",
        ),
        h(
          "div",
          { class: "map-route" },
          h(
            "button",
            { class: "small", onclick: () => navigate("coverage") },
            "What this explainer left out ▸",
          ),
        ),
      );
    const counts: [number, string, string][] = [
      [map.diff.added.length, "ok", "added"],
      [map.diff.changed.length, "warn", "changed"],
      [map.diff.removed.length, "del", "removed"],
    ];
    const marks = counts.filter(([n]) => n > 0);
    return h(
      "div",
      { class: "map-intro" },
      h("h2", null, "Where the change landed"),
      h(
        "p",
        null,
        "The Files tab has the lines. This has the parts of the system they landed in, and what",
        " those parts connect to — the neighbours a diff never names. Marked parts are the change;",
        " the rest is the context you need to judge it.",
      ),
      h(
        "div",
        { class: "map-route" },
        marks.length
          ? marks.map(([n, cls, word]) => h("span", { class: `badge ${cls}` }, `${n} ${word}`))
          : h("span", { class: "muted" }, "This change touched no part of the map."),
        route
          ? h(
              "button",
              {
                class: "small",
                onclick: () => navigate("map", { node: route.id }),
              },
              `Start at ${route.label} ›`,
            )
          : null,
        map.base
          ? null
          : h(
              "span",
              { class: "muted" },
              "No base map, so changed means touched by the diff and nothing reads as added or removed.",
            ),
      ),
    );
  };

  const crumbs = () => {
    const el = h("div", { class: "crumbs" });
    const parts = level ? level.split(".") : [];
    el.appendChild(h("span", { onclick: () => openLevel("") }, "System"));
    parts.forEach((_, i) => {
      const id = parts.slice(0, i + 1).join(".");
      el.appendChild(document.createTextNode(" › "));
      el.appendChild(h("span", { onclick: () => openLevel(id) }, all.get(id)?.label ?? id));
    });
    return el;
  };

  const card = (n: MapItem) => {
    const inside = [...all.keys()].filter((k) => parentOf(k) === n.id).length;
    const hidden = changedInside(all, n.id);
    const files = map.filesByNode[n.id]?.length ?? 0;
    return h(
      "div",
      {
        class: `map-node ${n.status} ${explainer || touched(all, n) ? "" : "quiet"} ${n.id === selected ? "selected" : ""}`,
        onclick: () => navigate("map", { node: n.id }),
        ondblclick: () => inside && openLevel(n.id),
      },
      n.status ? h("span", { class: `status badge ${statusClass(n.status)}` }, n.status) : null,
      h("div", { class: "kind" }, n.kind),
      h("div", { class: "label" }, n.label),
      n.description ? h("div", { class: "desc" }, n.description) : null,
      h(
        "div",
        { class: "meta" },
        files
          ? h("span", { class: "warn-text" }, `${files} changed file${files > 1 ? "s" : ""}`)
          : null,
        hidden ? h("span", { class: "warn-text" }, `${hidden} changed inside`) : null,
        inside
          ? h(
              "button",
              {
                class: "small drill",
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  openLevel(n.id);
                },
              },
              `Open ${inside} inside ›`,
            )
          : null,
      ),
    );
  };

  const board = () => {
    const kids = childrenOf(all, level, map.filesByNode);
    if (!kids.length) return h("div", { class: "empty-state" }, "Nothing at this level.");
    const hot = kids.filter((n) => touched(all, n));
    const cold = kids.filter((n) => !touched(all, n));
    const group = (title: string | null, items: MapItem[]) =>
      items.length
        ? h(
            "div",
            { class: "map-group" },
            title ? h("h3", null, title) : null,
            h("div", { class: "map-grid" }, items.map(card)),
          )
        : null;
    // An explainer has no change, so there is no reading order to impose: the
    // parts are drawn as the author grouped them, and none of them is "context".
    if (explainer) return group(null, kids) ?? h("div", null);
    if (!hot.length)
      return h(
        "div",
        null,
        h("div", { class: "map-note muted" }, "Nothing here was touched. The change is elsewhere."),
        group(null, cold),
      );
    return h(
      "div",
      null,
      group(cold.length ? "What the change touched" : null, hot),
      group("Context — unchanged here", cold),
    );
  };

  // Links, folded up to the parts on screen. An edge between two boxes inside
  // the same card belongs to that card's level, not this one; what matters here
  // is which visible parts a change can travel between.
  const links = () => {
    const here = new Set(childrenOf(all, level, map.filesByNode).map((k) => k.id));
    const top = (id: string) => {
      let x = id;
      while (x && !here.has(x)) x = parentOf(x);
      return x;
    };
    const folded: MapEdge[] = [];
    for (const e of edges) {
      // An endpoint outside this subtree folds to nothing, and a link arriving
      // from elsewhere is exactly the one worth keeping: it stays under its own
      // name so the reader can see what reaches in.
      const from = top(e.from) || e.from;
      const to = top(e.to) || e.to;
      if (from === to) continue;
      if (!here.has(from) && !here.has(to)) continue;
      if (folded.some((x) => x.from === from && x.to === to)) continue;
      folded.push({ from, to, ...(e.label ? { label: e.label } : {}) });
    }
    if (!folded.length) return null;
    return h(
      "div",
      { class: "map-edges" },
      h("h3", null, "What connects to what here"),
      h(
        "div",
        { class: "muted map-note" },
        explainer
          ? "A link is a dependency the parts have on each other, drawn as the author declared it."
          : "A link touching a changed part is where the two sides can fall out of step.",
      ),
      rankEdges(folded, all).map(({ edge, touchesChange }) =>
        h(
          "div",
          { class: `edge ${touchesChange ? "hot" : ""}` },
          h(
            "b",
            { onclick: () => navigate("map", { node: edge.from }) },
            all.get(edge.from)?.label ?? edge.from,
          ),
          "→",
          h(
            "b",
            { onclick: () => navigate("map", { node: edge.to }) },
            all.get(edge.to)?.label ?? edge.to,
          ),
          h("span", { class: "muted" }, edge.label ?? ""),
        ),
      ),
    );
  };

  const draw = () => {
    canvas.innerHTML = "";
    append(canvas, [intro(), crumbs(), board(), links()]);
    drawSide();
  };

  const drawSide = () => {
    side.innerHTML = "";
    const n = selected ? all.get(selected) : null;
    if (!n) {
      side.appendChild(
        h(
          "div",
          { class: "muted" },
          explainer
            ? "Pick a part to see what it owns, the code behind it, and what it connects to."
            : "Pick a part to see what changed in it, the code behind it, and what it connects to.",
        ),
      );
      return;
    }
    const anchor = n.anchor ? state.data?.document?.anchors[n.anchor] : null;
    const files = map.filesByNode[n.id] ?? [];
    const threads = threadsFor((t) => t.type === "map" && t.node === n.id);
    const neighbours = neighboursOf(map, n.id);
    append(side, [
      h(
        "div",
        { class: "kind muted", style: { fontSize: "11px", textTransform: "uppercase" } },
        n.kind,
        " ",
        n.status ? h("span", { class: `badge ${statusClass(n.status)}` }, n.status) : "",
      ),
      h("h3", { style: { margin: "2px 0 6px" } }, n.label),
      h("div", { class: "mono muted", style: { fontSize: "11px" } }, n.id),
      n.description ? h("p", null, n.description) : null,
      anchor?.peek
        ? h(
            "p",
            null,
            h("button", { class: "small", onclick: () => openAnchorPeek(anchor) }, "Peek code ▸"),
            " ",
            h("span", { class: "mono muted" }, `${anchor.peek.file}:${anchor.peek.from}`),
          )
        : null,
      n.files?.length
        ? h(
            "div",
            { class: "muted", style: { marginTop: "8px" } },
            "Owns: ",
            n.files.map((g) => h("code", null, g + " ")),
          )
        : null,
      files.length
        ? h(
            "div",
            { style: { marginTop: "8px" } },
            h("b", null, "Changed files"),
            files.map((f) =>
              h("span", { class: "file", onclick: () => navigate("files", { path: f }) }, f),
            ),
          )
        : null,
      neighbours.length
        ? h(
            "div",
            { class: "neighbours", style: { marginTop: "12px" } },
            h("b", null, "Next to it"),
            h(
              "div",
              { class: "muted", style: { fontSize: "11px" } },
              "→ this reaches · ← reaches this",
            ),
            neighbours.map((x) => {
              const other = all.get(x.other);
              return h(
                "div",
                { class: "neighbour" },
                h("span", { class: "mono muted" }, x.dir === "out" ? "→" : "←"),
                h(
                  "span",
                  { class: "nb", onclick: () => navigate("map", { node: x.other }) },
                  other?.label ?? x.other,
                ),
                other?.status
                  ? h("span", { class: `badge ${statusClass(other.status)}` }, other.status)
                  : null,
                x.label ? h("span", { class: "muted" }, x.label) : null,
              );
            }),
          )
        : null,
      h(
        "div",
        { style: { marginTop: "12px" } },
        h(
          "button",
          {
            class: "small",
            onclick: (e: MouseEvent) =>
              popover(commentPopover({ type: "map", node: n.id }), { x: e.pageX, y: e.pageY + 8 }),
          },
          "Comment on this node",
        ),
      ),
      threads.length
        ? h(
            "div",
            { class: "thread-pins", style: { marginTop: "10px" } },
            threads.map(threadPinRow),
          )
        : null,
    ]);
    if (n.status === "changed" && baseNodes.has(n.id) && headNodes.has(n.id)) {
      const b = baseNodes.get(n.id)!;
      const hh = headNodes.get(n.id)!;
      const diffs: string[] = [];
      if (b.label !== hh.label) diffs.push(`label: ${b.label} → ${hh.label}`);
      if (b.description !== hh.description) diffs.push(`description changed`);
      if (JSON.stringify(b.files) !== JSON.stringify(hh.files))
        diffs.push(`files: ${(b.files ?? []).join(", ")} → ${(hh.files ?? []).join(", ")}`);
      if (diffs.length)
        side.appendChild(
          h(
            "div",
            { style: { marginTop: "10px" } },
            h("b", null, "Base → head"),
            diffs.map((d) => h("div", { class: "muted" }, d)),
          ),
        );
    }
  };
  draw();
}
