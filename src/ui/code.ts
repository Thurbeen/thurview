import { api } from "./api.js";
import { h, popover, closePopover } from "./dom.js";
import { state, emit, threadsFor, navigate } from "./state.js";
import type { Thread, ThreadTarget } from "../store.js";
import type { CompiledAnchor } from "../document/compile.js";
import { commentPopover, threadPinRow } from "./threads.js";

export interface CodeOpts {
  path: string;
  graph: "head" | "base";
  startLine: number;
  lines: string[];
  highlight?: [number, number];
  /** line numbers that carry threads are decorated; clicking a number starts a comment */
  commentable?: boolean;
  onExpand?: (dir: "up" | "down") => void;
}

/** Renders highlighted lines as a table. */
export function codeTable(o: CodeOpts): HTMLTableElement {
  const table = h("table");
  const threads = o.commentable
    ? threadsFor((t) => t.type === "file" && t.path === o.path && t.side === o.graph)
    : [];
  const endOf = (t: Thread) => (t.target.type === "file" ? (t.target.endLine ?? t.target.line) : 0);
  o.lines.forEach((html, i) => {
    const n = o.startLine + i;
    const hl = o.highlight && n >= o.highlight[0] && n <= o.highlight[1];
    const lineThreads = threads.filter((t) => endOf(t) === n);
    const tr = h(
      "tr",
      { class: `${hl ? "hl" : ""} ${lineThreads.length ? "commented" : ""}`, "data-line": n },
      h(
        "td",
        {
          class: "ln",
          title: o.commentable ? "Comment on this line (shift-click for a range)" : "",
          onclick: (e: MouseEvent) => o.commentable && lineClick(e, o.path, o.graph, n, table),
        },
        String(n),
      ),
      h("td", { class: "src", html: html || " " }),
    );
    table.appendChild(tr);
    for (const t of lineThreads)
      table.appendChild(h("tr", { class: "thread-row" }, h("td", { colspan: 2 }, threadPinRow(t))));
  });
  attachDefinitions(table, o.graph);
  return table;
}

function textOf(html: string): string {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent ?? "";
}

export function startLineComment(e: MouseEvent, target: ThreadTarget, quote?: string): void {
  if (state.viewingRevision !== null) return;
  const el = commentPopover(target, quote?.trim() ? quote.trim() : undefined);
  popover(el, { x: e.pageX + 8, y: e.pageY + 8 });
}

/** First click marks a line; shift-click on the same table extends it to a range. */
let rangeStart: {
  path: string;
  side: "head" | "base";
  line: number;
  table: HTMLTableElement;
} | null = null;

export function lineClick(
  e: MouseEvent,
  path: string,
  side: "head" | "base",
  line: number,
  table: HTMLTableElement,
): void {
  if (state.viewingRevision !== null) return;
  if (e.shiftKey && rangeStart && rangeStart.path === path && rangeStart.side === side) {
    const from = Math.min(rangeStart.line, line);
    const to = Math.max(rangeStart.line, line);
    const quote = rowsText(table, side, from, to);
    clearRangeMarks(table);
    for (let n = from; n <= to; n++)
      table.querySelector(`tr[data-${side}="${n}"]`)?.classList.add("range-sel");
    rangeStart = null;
    startLineComment(e, { type: "file", path, side, line: from, endLine: to }, quote);
    return;
  }
  rangeStart = { path, side, line, table };
  clearRangeMarks(table);
  table.querySelector(`tr[data-${side}="${line}"]`)?.classList.add("range-sel");
  startLineComment(e, { type: "file", path, side, line }, rowsText(table, side, line, line));
}

function clearRangeMarks(table: HTMLTableElement): void {
  table.querySelectorAll("tr.range-sel").forEach((tr) => tr.classList.remove("range-sel"));
}

export function rowsText(
  table: HTMLElement,
  side: "head" | "base",
  from: number,
  to: number,
): string {
  const parts: string[] = [];
  for (let n = from; n <= to; n++) {
    const td = table.querySelector(`tr[data-${side}="${n}"] td.src`);
    if (td) parts.push((td.textContent ?? "").replace(/^[+\- ]/, ""));
  }
  return parts.join("\n").slice(0, 400);
}

/** Selecting code text inside `root` offers a comment on the spanned lines. */
export function codeSelectionHandler(root: HTMLElement): void {
  let btn: HTMLElement | null = null;
  const remove = () => {
    btn?.remove();
    btn = null;
  };
  const onChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !root.isConnected) return remove();
    const range = sel.getRangeAt(0);
    const rowOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest(
        "tr[data-head], tr[data-base]",
      ) as HTMLElement | null;
    const a = rowOf(range.startContainer);
    const b = rowOf(range.endContainer);
    if (!a || !b || !root.contains(a) || !root.contains(b) || state.viewingRevision !== null)
      return remove();
    const table = a.closest("table");
    if (!table || table !== b.closest("table")) return remove();
    const path = (root.closest("[data-path]") as HTMLElement | null)?.dataset["path"] ?? "";
    const side: "head" | "base" = a.dataset["head"] && b.dataset["head"] ? "head" : "base";
    const la = Number(a.dataset[side]);
    const lb = Number(b.dataset[side]);
    if (!la || !lb) return remove();
    const from = Math.min(la, lb);
    const to = Math.max(la, lb);
    const quote = sel.toString().trim().slice(0, 400);
    remove();
    const rect = range.getBoundingClientRect();
    btn = h(
      "button",
      {
        class: "small primary selection-btn",
        onmousedown: (e: MouseEvent) => e.preventDefault(),
        onclick: (e: MouseEvent) => {
          remove();
          window.getSelection()?.removeAllRanges();
          startLineComment(
            e,
            { type: "file", path, side, line: from, ...(to > from ? { endLine: to } : {}) },
            quote,
          );
        },
      },
      to > from ? `Comment on lines ${from}-${to}` : `Comment on line ${from}`,
    );
    btn.style.left = `${rect.left + window.scrollX}px`;
    btn.style.top = `${rect.bottom + window.scrollY + 6}px`;
    document.body.appendChild(btn);
  };
  document.addEventListener("selectionchange", onChange);
}

/** Click on an identifier: look up definitions at the pinned commit. Ctrl/Cmd+click jumps to the first one. */
export function attachDefinitions(root: HTMLElement, graph: "head" | "base"): void {
  root.addEventListener("click", async (e) => {
    const td = (e.target as HTMLElement).closest("td.src");
    if (!td) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const word = wordAt(e);
    if (!word) return;
    const defs = await api.symbols(state.id, word, graph);
    if (e.ctrlKey || e.metaKey) {
      const d = defs[0];
      if (d) openPeekAt(d.path, graph, d.line, `${d.kind} ${d.name}`);
      return;
    }
    const box = h("div", { class: "def-popover" });
    if (!defs.length)
      box.appendChild(
        h(
          "div",
          { class: "empty" },
          `No definition of `,
          h("code", null, word),
          ` found at ${graph}`,
        ),
      );
    for (const d of defs) {
      box.appendChild(
        h(
          "div",
          {
            class: "item",
            onclick: () => {
              closePopover();
              openPeekAt(d.path, graph, d.line, `${d.kind} ${d.name}`);
            },
          },
          h("span", { class: "kind" }, d.kind),
          h("span", { class: "mono" }, `${d.path}:${d.line}`),
        ),
      );
    }
    popover(box, { x: e.pageX + 6, y: e.pageY + 10 });
  });
}

function wordAt(e: MouseEvent): string | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m.index <= offset && offset <= m.index + m[0].length) return m[0];
  return null;
}

/** Side peek: an anchor from the document, or an arbitrary location. */
export interface PeekSpec {
  title: string;
  detail?: string;
  path: string;
  graph: "head" | "base";
  from: number;
  to: number;
  lines: string[];
  total: number;
  anchorId?: string;
}

let current: PeekSpec | null = null;
export function currentPeek(): PeekSpec | null {
  return current;
}

export function openAnchorPeek(a: CompiledAnchor): void {
  if (!a.peek) return;
  current = {
    title: a.title,
    detail: a.detail,
    path: a.peek.file,
    graph: a.peek.graph,
    from: a.peek.from,
    to: a.peek.to,
    lines: a.peek.lines,
    total: a.peek.total,
    anchorId: a.id,
  };
  state.side = { kind: "peek", anchor: a.id };
  emit("side");
  location.hash = location.hash.replace(/&?anchor=[^&]*/, "");
}

export async function openPeekAt(
  path: string,
  graph: "head" | "base",
  line: number,
  title?: string,
): Promise<void> {
  const from = Math.max(1, line - 5);
  const f = await api.file(state.id, path, graph, from, line + 12);
  current = {
    title: title ?? path,
    path,
    graph,
    from: f.from,
    to: f.to,
    lines: f.lines,
    total: f.total,
  };
  current.highlightLine = line;
  state.side = { kind: "peek" };
  emit("side");
}

export interface PeekSpec {
  highlightLine?: number;
}

export function renderPeek(container: HTMLElement): void {
  const p = current;
  if (!p) return;
  const inChanges = !!state.data?.changes.some((c) => c.path === p.path);
  const head = h(
    "div",
    { class: "side-head" },
    h(
      "div",
      { style: { flex: "1", minWidth: "0" } },
      h("div", { style: { fontWeight: "600" } }, p.title),
      h(
        "div",
        {
          class: "path",
          title: p.path,
          onclick: () =>
            navigate("files", { path: p.path, line: p.highlightLine ?? p.from, side: p.graph }),
        },
        `${p.path}:${p.from}-${p.to}`,
        " ",
        h("span", { class: `badge ${p.graph === "base" ? "del" : ""}` }, p.graph),
      ),
    ),
    h(
      "button",
      {
        class: "small",
        onclick: () =>
          navigate("files", { path: p.path, line: p.highlightLine ?? p.from, side: p.graph }),
      },
      inChanges ? "Open in Files" : "Open file",
    ),
    h(
      "button",
      {
        class: "small ghost",
        onclick: () => {
          state.side = { kind: "none" };
          emit("side");
        },
      },
      "✕",
    ),
  );
  const body = h("div", { class: "side-body" });
  if (p.detail)
    body.appendChild(
      h("div", { class: "muted", style: { padding: "8px 12px", fontSize: "13px" } }, p.detail),
    );
  const frame = h("div", { class: "code" });
  const draw = () => {
    frame.innerHTML = "";
    const bar = (dir: "up" | "down") => {
      const can = dir === "up" ? p.from > 1 : p.to < p.total;
      return h(
        "div",
        { class: "expand-bar" },
        can
          ? h(
              "button",
              { class: "small ghost", onclick: () => expand(dir) },
              dir === "up" ? "↑ 20 more lines" : "↓ 20 more lines",
            )
          : h("span", { class: "muted" }, dir === "up" ? "start of file" : "end of file"),
      );
    };
    frame.appendChild(bar("up"));
    frame.appendChild(
      codeTable({
        path: p.path,
        graph: p.graph,
        startLine: p.from,
        lines: p.lines,
        highlight: p.highlightLine
          ? [p.highlightLine, p.highlightLine]
          : p.anchorId
            ? [p.from, p.to]
            : undefined,
        commentable: true,
      }),
    );
    frame.appendChild(bar("down"));
  };
  const expand = async (dir: "up" | "down") => {
    if (dir === "up") {
      const from = Math.max(1, p.from - 20);
      const f = await api.file(state.id, p.path, p.graph, from, p.from - 1);
      p.lines = [...f.lines, ...p.lines];
      p.from = from;
    } else {
      const to = Math.min(p.total, p.to + 20);
      const f = await api.file(state.id, p.path, p.graph, p.to + 1, to);
      p.lines = [...p.lines, ...f.lines];
      p.to = to;
    }
    if (p.anchorId) {
      // keep the original range highlighted
      const a = state.data?.document?.anchors[p.anchorId];
      if (a?.peek) p.highlightRange = [a.peek.from, a.peek.to];
    }
    draw();
  };
  draw();
  body.appendChild(frame);
  container.appendChild(head);
  container.appendChild(body);
}

export interface PeekSpec {
  highlightRange?: [number, number];
}

export function threadsForFile(path: string, side: "head" | "base", line: number): Thread[] {
  return threadsFor(
    (t) => t.type === "file" && t.path === path && t.side === side && t.line === line,
  );
}
