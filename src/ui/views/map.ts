import { h, append, popover } from "../dom.js";
import { state, navigate, threadsFor } from "../state.js";
import { openAnchorPeek } from "../code.js";
import { commentPopover, threadPinRow } from "../threads.js";
import type { MapNode, MapEdge } from "../../document/schema.js";

export function renderMap(root: HTMLElement): void {
  const map = state.data?.map;
  if (!map) {
    root.appendChild(
      h(
        "div",
        { class: "empty-state" },
        "No software map in this revision. The agent authors ",
        h("code", null, "map.yaml"),
        " and publishes again.",
      ),
    );
    return;
  }
  const headNodes = new Map(map.head.nodes.map((n) => [n.id, n]));
  const baseNodes = new Map((map.base?.nodes ?? []).map((n) => [n.id, n]));
  const all = new Map<string, MapNode & { status: "added" | "removed" | "changed" | "" }>();
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
    const n = baseNodes.get(id);
    if (n) all.set(id, { ...n, status: "removed" });
  }
  const edges: MapEdge[] = [...map.head.edges];
  for (const e of map.base?.edges ?? [])
    if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);

  const selected = state.params.get("node") ?? "";
  const parentOf = (id: string) => (id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "");
  let level =
    selected && all.has(selected)
      ? childrenOf(selected).length
        ? selected
        : parentOf(selected)
      : "";

  function childrenOf(p: string) {
    return [...all.values()].filter((n) => parentOf(n.id) === p);
  }
  function descendantsChanged(id: string) {
    return [...all.values()].filter((n) => n.id.startsWith(id + ".") && n.status).length;
  }
  const canvas = h("div", { class: "map-canvas" });
  const side = h("div", { class: "map-side" });
  root.appendChild(h("div", { class: "map-layout" }, canvas, side));

  const draw = () => {
    canvas.innerHTML = "";
    const crumbs = h("div", { class: "crumbs" });
    const parts = level ? level.split(".") : [];
    crumbs.appendChild(
      h(
        "span",
        {
          onclick: () => {
            level = "";
            draw();
          },
        },
        "System",
      ),
    );
    parts.forEach((_, i) => {
      const id = parts.slice(0, i + 1).join(".");
      crumbs.appendChild(document.createTextNode(" › "));
      crumbs.appendChild(
        h(
          "span",
          {
            onclick: () => {
              level = id;
              draw();
            },
          },
          all.get(id)?.label ?? id,
        ),
      );
    });
    canvas.appendChild(crumbs);
    const kids = childrenOf(level);
    const legend = h(
      "div",
      { class: "muted", style: { fontSize: "12px", marginBottom: "10px" } },
      h("span", { class: "badge ok" }, `${map.diff.added.length} added`),
      " ",
      h("span", { class: "badge del" }, `${map.diff.removed.length} removed`),
      " ",
      h("span", { class: "badge warn" }, `${map.diff.changed.length} changed`),
      map.base ? "" : "  (no base map: changed = touched by the diff)",
    );
    canvas.appendChild(legend);
    const grid = h("div", { class: "map-grid" });
    for (const n of kids) {
      const nk = childrenOf(n.id).length;
      const files = map.filesByNode[n.id]?.length ?? 0;
      grid.appendChild(
        h(
          "div",
          {
            class: `map-node ${n.status} ${n.id === selected ? "selected" : ""}`,
            onclick: () => {
              navigate("map", { node: n.id });
            },
            ondblclick: () => {
              if (nk) {
                level = n.id;
                draw();
              }
            },
          },
          n.status
            ? h(
                "span",
                {
                  class: `status badge ${n.status === "added" ? "ok" : n.status === "removed" ? "del" : "warn"}`,
                },
                n.status,
              )
            : null,
          h("div", { class: "kind" }, n.kind),
          h("div", { class: "label" }, n.label),
          n.description ? h("div", { class: "desc" }, n.description) : null,
          h(
            "div",
            { class: "children" },
            nk ? `${nk} inside · dbl-click to open` : "",
            nk && descendantsChanged(n.id) ? ` · ${descendantsChanged(n.id)} changed` : "",
            files ? ` · ${files} changed file${files > 1 ? "s" : ""}` : "",
          ),
        ),
      );
    }
    if (!kids.length)
      grid.appendChild(h("div", { class: "empty-state" }, "Nothing at this level."));
    canvas.appendChild(grid);
    const here = new Set(kids.map((k) => k.id));
    const top = (id: string) => {
      let x = id;
      while (x && !here.has(x)) x = parentOf(x);
      return x;
    };
    const shown = edges.filter((e) => here.has(top(e.from)) || here.has(top(e.to)));
    if (shown.length) {
      canvas.appendChild(
        h(
          "div",
          { class: "map-edges" },
          h("div", { class: "muted", style: { marginBottom: "4px" } }, "Relationships"),
          shown.map((e) =>
            h(
              "div",
              { class: "edge" },
              h(
                "b",
                { onclick: () => navigate("map", { node: e.from }) },
                all.get(e.from)?.label ?? e.from,
              ),
              "→",
              h(
                "b",
                { onclick: () => navigate("map", { node: e.to }) },
                all.get(e.to)?.label ?? e.to,
              ),
              h("span", { class: "muted" }, e.label ?? ""),
            ),
          ),
        ),
      );
    }
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
          "Select a node to see its files, code and relationships. Double-click to drill in.",
        ),
      );
      return;
    }
    const anchor = n.anchor ? state.data?.document?.anchors[n.anchor] : null;
    const files = map.filesByNode[n.id] ?? [];
    const threads = threadsFor((t) => t.type === "map" && t.node === n.id);
    append(side, [
      h(
        "div",
        { class: "kind muted", style: { fontSize: "11px", textTransform: "uppercase" } },
        n.kind,
        " ",
        n.status
          ? h(
              "span",
              {
                class: `badge ${n.status === "added" ? "ok" : n.status === "removed" ? "del" : "warn"}`,
              },
              n.status,
            )
          : "",
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
