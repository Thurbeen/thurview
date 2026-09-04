import { api } from "../api.js";
import { h } from "../dom.js";
import { state, navigate, isNarrow } from "../state.js";
import { attachDefinitions, startLineComment, lineClick, codeSelectionHandler } from "../code.js";
import { threadPinRow } from "../threads.js";
import type { FileDiff, DiffRow } from "../../diff.js";
import type { Thread } from "../../store.js";

export function renderFiles(root: HTMLElement): void {
  const changes = state.data?.changes ?? [];
  const path = state.params.get("path") ?? changes[0]?.path ?? "";
  const list = h("div", { class: "file-list" });
  for (const c of changes) {
    const n = (state.data?.threads ?? []).filter(
      (t) => t.target.type === "file" && t.target.path === c.path && t.status === "open",
    ).length;
    list.appendChild(
      h(
        "div",
        {
          class: `item ${c.path === path ? "active" : ""}`,
          onclick: () => navigate("files", { path: c.path }),
        },
        h(
          "span",
          {
            class: `badge ${c.status === "A" ? "ok" : c.status === "D" ? "del" : ""}`,
            style: { minWidth: "20px", textAlign: "center" },
          },
          c.status,
        ),
        h("span", { class: "name", title: c.path }, c.path),
        n ? h("span", { class: "badge accent" }, String(n)) : null,
        h(
          "span",
          { class: "stat" },
          h("span", { class: "a" }, `+${c.additions}`),
          " ",
          h("span", { class: "d" }, `−${c.deletions}`),
        ),
      ),
    );
  }
  if (!changes.length)
    list.appendChild(
      h("div", { class: "empty-state" }, "No changed files: base and head are the same commit."),
    );
  const view = h("div", { class: "file-view", "data-path": path });
  root.appendChild(h("div", { class: "files-layout" }, list, view));
  if (path) void renderDiff(view, path);
}

async function renderDiff(view: HTMLElement, path: string): Promise<void> {
  const inChanges = state.data?.changes.some((c) => c.path === path);
  const line = Number(state.params.get("line") ?? 0);
  const side = state.params.get("side") === "base" ? "base" : "head";
  view.appendChild(h("div", { class: "muted", style: { padding: "12px" } }, "Loading…"));
  let d: FileDiff;
  try {
    if (inChanges) d = await api.diff(state.id, path);
    else {
      const f = await api.file(state.id, path, side);
      d = {
        path,
        lang: f.lang,
        binary: false,
        oldTotal: 0,
        newTotal: f.total,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: f.total,
            rows: f.lines.map((html, i) => ({
              type: "context",
              newLine: i + 1,
              oldLine: i + 1,
              html,
            })),
          },
        ],
      };
    }
  } catch (e) {
    view.innerHTML = "";
    view.appendChild(h("div", { class: "empty-state" }, (e as Error).message));
    return;
  }
  view.innerHTML = "";
  // Split needs two code columns; below the breakpoint there is room for one.
  const split = state.splitDiff && inChanges && !isNarrow();
  const toggle = h(
    "button",
    {
      class: "small",
      onclick: () => {
        state.splitDiff = !state.splitDiff;
        localStorage.setItem("thurview.split", state.splitDiff ? "1" : "0");
        view.innerHTML = "";
        void renderDiff(view, path);
      },
    },
    state.splitDiff ? "Unified" : "Split",
  );
  const fileThreads = (state.data?.threads ?? []).filter(
    (t) => t.target.type === "file" && t.target.path === path && t.target.line === 0,
  );
  view.appendChild(
    h(
      "div",
      { class: "file-head" },
      h("span", { class: "path" }, d.oldPath ? `${d.oldPath} → ${path}` : path),
      h(
        "span",
        { class: "muted" },
        `${d.hunks.reduce((n, hk) => n + hk.rows.filter((r) => r.type === "add").length, 0)} added · ${d.hunks.reduce((n, hk) => n + hk.rows.filter((r) => r.type === "del").length, 0)} deleted`,
      ),
      h(
        "span",
        { class: "muted hint" },
        "click a line number to comment · shift-click or select text for a range",
      ),
      state.viewingRevision === null
        ? h(
            "button",
            {
              class: "small",
              onclick: (e: MouseEvent) =>
                startLineComment(e, { type: "file", path, side: "head", line: 0 }),
            },
            fileThreads.length ? `File comments (${fileThreads.length})` : "Comment on file",
          )
        : null,
      inChanges
        ? isNarrow()
          ? null
          : toggle
        : h("span", { class: "badge" }, `full file at ${side}`),
    ),
  );
  if (fileThreads.length)
    view.appendChild(
      h(
        "div",
        { class: "thread-pins", style: { margin: "8px 14px" } },
        fileThreads.map(threadPinRow),
      ),
    );
  if (d.binary) {
    view.appendChild(h("div", { class: "empty-state" }, "Binary file"));
    return;
  }
  const threads = (state.data?.threads ?? []).filter(
    (t): t is Thread & { target: { type: "file" } } =>
      t.target.type === "file" && t.target.path === path,
  );
  const el = split ? splitView(d, threads) : unifiedView(d, threads);
  view.appendChild(el);
  codeSelectionHandler(view);
  if (line) {
    const tr = el.querySelector(`tr[data-${side}="${line}"]`) as HTMLElement | null;
    if (tr) {
      tr.classList.add("hl");
      tr.scrollIntoView({ block: "center" });
    }
  }
}

function lineCell(
  path: string,
  side: "head" | "base",
  n: number | undefined,
  _text: string,
): HTMLElement {
  return h(
    "td",
    {
      class: "ln",
      title: n ? "Comment on this line (shift-click for a range)" : "",
      onclick: (e: MouseEvent) => {
        const table = (e.currentTarget as HTMLElement).closest("table") as HTMLTableElement | null;
        if (n && table) lineClick(e, path, side, n, table);
      },
    },
    n ? String(n) : "",
  );
}

function threadRows(
  threads: (Thread & { target: { type: "file" } })[],
  side: "head" | "base",
  n: number | undefined,
  colspan: number,
): HTMLElement[] {
  if (!n) return [];
  return threads
    .filter((t) => t.target.side === side && (t.target.endLine ?? t.target.line) === n)
    .map((t) => h("tr", { class: "thread-row" }, h("td", { colspan }, threadPinRow(t))));
}

function gapRow(
  d: FileDiff,
  from: number,
  to: number,
  colspan: number,
  onExpand: (rows: DiffRow[]) => void,
): HTMLElement | null {
  if (to < from) return null;
  const count = to - from + 1;
  return h(
    "tr",
    { class: "gap" },
    h(
      "td",
      {
        colspan,
        onclick: async () => {
          const f = await api.file(state.id, d.path, "head", from, to);
          // map head line -> old line by offset within this gap (context lines only)
          onExpand(
            f.lines.map((html, i) => ({
              type: "context",
              newLine: from + i,
              oldLine: from + i - (gapOffset(d, from) ?? 0),
              html,
            })),
          );
        },
      },
      `⋯ ${count} unchanged line${count > 1 ? "s" : ""}`,
    ),
  );
}

function gapOffset(d: FileDiff, newLine: number): number | undefined {
  // offset between new and old numbering before this gap
  let off = 0;
  for (const hk of d.hunks) {
    if (hk.newStart > newLine) break;
    off = hk.newStart + hk.newLines - (hk.oldStart + hk.oldLines);
  }
  return off;
}

function unifiedView(d: FileDiff, threads: (Thread & { target: { type: "file" } })[]): HTMLElement {
  const table = h("table");
  const text = (html: string) => {
    const x = document.createElement("div");
    x.innerHTML = html;
    return x.textContent ?? "";
  };
  const rowEl = (r: DiffRow) => {
    const tr = h(
      "tr",
      { class: r.type, "data-head": r.newLine ?? "", "data-base": r.oldLine ?? "" },
      lineCell(d.path, "base", r.oldLine, text(r.html)),
      lineCell(d.path, "head", r.newLine, text(r.html)),
      h("td", {
        class: "src",
        html: (r.type === "add" ? "+" : r.type === "del" ? "-" : " ") + (r.html || " "),
      }),
    );
    return [
      tr,
      ...threadRows(
        threads,
        r.type === "del" ? "base" : "head",
        r.type === "del" ? r.oldLine : r.newLine,
        3,
      ),
    ];
  };
  let prevEnd = 0;
  d.hunks.forEach((hk, i) => {
    const gap = gapRow(d, prevEnd + 1, hk.newStart - 1, 3, (rows) => {
      const g = table.querySelector(`tr.gap[data-i="${i}"]`);
      if (!g) return;
      rows.flatMap(rowEl).forEach((r) => table.insertBefore(r, g));
      g.remove();
    });
    if (gap) {
      gap.dataset["i"] = String(i);
      table.appendChild(gap);
    }
    for (const r of hk.rows) rowEl(r).forEach((x) => table.appendChild(x));
    prevEnd = hk.newStart + hk.newLines - 1;
  });
  if (d.newTotal > prevEnd) {
    const gap = gapRow(d, prevEnd + 1, d.newTotal, 3, (rows) => {
      const g = table.querySelector("tr.gap.tail");
      if (!g) return;
      rows.flatMap(rowEl).forEach((r) => table.insertBefore(r, g));
      g.remove();
    });
    if (gap) {
      gap.classList.add("tail");
      table.appendChild(gap);
    }
  }
  const wrap = h("div", { class: "code" }, table);
  attachDefinitions(wrap, "head");
  return wrap;
}

function splitView(d: FileDiff, threads: (Thread & { target: { type: "file" } })[]): HTMLElement {
  const left = h("table");
  const right = h("table");
  const text = (html: string) => {
    const x = document.createElement("div");
    x.innerHTML = html;
    return x.textContent ?? "";
  };
  const pair = (l: DiffRow | null, r: DiffRow | null) => {
    const ltr = l
      ? h(
          "tr",
          { class: l.type === "del" ? "del" : "", "data-base": l.oldLine ?? "" },
          lineCell(d.path, "base", l.oldLine, text(l.html)),
          h("td", { class: "src", html: l.html || " " }),
        )
      : h("tr", null, h("td", { class: "ln empty" }), h("td", { class: "src empty" }, " "));
    const rtr = r
      ? h(
          "tr",
          { class: r.type === "add" ? "add" : "", "data-head": r.newLine ?? "" },
          lineCell(d.path, "head", r.newLine, text(r.html)),
          h("td", { class: "src", html: r.html || " " }),
        )
      : h("tr", null, h("td", { class: "ln empty" }), h("td", { class: "src empty" }, " "));
    left.appendChild(ltr);
    right.appendChild(rtr);
    const lt = threadRows(threads, "base", l?.oldLine, 2);
    const rt = threadRows(threads, "head", r?.newLine, 2);
    // keep both sides aligned: pad the shorter side
    const n = Math.max(lt.length, rt.length);
    for (let i = 0; i < n; i++) {
      left.appendChild(lt[i] ?? h("tr", { class: "thread-row" }, h("td", { colspan: 2 }, " ")));
      right.appendChild(rt[i] ?? h("tr", { class: "thread-row" }, h("td", { colspan: 2 }, " ")));
    }
  };
  const emitRows = (rows: DiffRow[]) => {
    let i = 0;
    while (i < rows.length) {
      const r = rows[i]!;
      if (r.type === "context") {
        pair(r, r);
        i++;
        continue;
      }
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (i < rows.length && rows[i]!.type === "del") dels.push(rows[i++]!);
      while (i < rows.length && rows[i]!.type === "add") adds.push(rows[i++]!);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) pair(dels[k] ?? null, adds[k] ?? null);
    }
  };
  let prevEnd = 0;
  const gapBoth = (from: number, to: number) => {
    if (to < from) return;
    const count = to - from + 1;
    const lg = h("tr", { class: "gap" }, h("td", { colspan: 2 }, `⋯ ${count} unchanged`));
    const rg = h("tr", { class: "gap" }, h("td", { colspan: 2 }, `⋯ ${count} unchanged`));
    const expand = async () => {
      const f = await api.file(state.id, d.path, "head", from, to);
      const off = gapOffset(d, from) ?? 0;
      const rows: DiffRow[] = f.lines.map((html, k) => ({
        type: "context",
        newLine: from + k,
        oldLine: from + k - off,
        html,
      }));
      const lAnchor = lg.nextSibling;
      const rAnchor = rg.nextSibling;
      lg.remove();
      rg.remove();
      const tmpL = left;
      const tmpR = right;
      const fragL = document.createDocumentFragment();
      const fragR = document.createDocumentFragment();
      for (const r of rows) {
        fragL.appendChild(
          h(
            "tr",
            { "data-base": r.oldLine ?? "" },
            lineCell(d.path, "base", r.oldLine, text(r.html)),
            h("td", { class: "src", html: r.html || " " }),
          ),
        );
        fragR.appendChild(
          h(
            "tr",
            { "data-head": r.newLine ?? "" },
            lineCell(d.path, "head", r.newLine, text(r.html)),
            h("td", { class: "src", html: r.html || " " }),
          ),
        );
      }
      tmpL.insertBefore(fragL, lAnchor);
      tmpR.insertBefore(fragR, rAnchor);
    };
    lg.addEventListener("click", expand);
    rg.addEventListener("click", expand);
    left.appendChild(lg);
    right.appendChild(rg);
  };
  for (const hk of d.hunks) {
    gapBoth(prevEnd + 1, hk.newStart - 1);
    emitRows(hk.rows);
    prevEnd = hk.newStart + hk.newLines - 1;
  }
  gapBoth(prevEnd + 1, d.newTotal);
  const l = h("div", { class: "code" }, left);
  const r = h("div", { class: "code" }, right);
  attachDefinitions(l, "base");
  attachDefinitions(r, "head");
  // synced horizontal scroll
  l.addEventListener("scroll", () => (r.scrollLeft = l.scrollLeft));
  r.addEventListener("scroll", () => (l.scrollLeft = r.scrollLeft));
  return h("div", { class: "split" }, l, r);
}
