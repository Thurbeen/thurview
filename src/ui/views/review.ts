import { h, popover } from "../dom.js";
import { state, threadsFor, navigate, kind } from "../state.js";
import { codeTable, openAnchorPeek } from "../code.js";
import { commentPopover, threadPinRow } from "../threads.js";
import { sequenceDiagram, callstackDiff, databaseLens } from "../diagrams.js";
import type { Block } from "../../document/compile.js";
import type { InterfaceDelta, InterfaceEntry } from "../../interfaces.js";
import type { Coverage } from "../../coverage.js";

export function renderReview(root: HTMLElement): void {
  const doc = state.data?.document;
  if (!doc) {
    root.appendChild(
      h(
        "div",
        { class: "empty-state" },
        "Nothing published yet. The agent publishes a revision with ",
        h("code", null, "thurview publish"),
        ".",
      ),
    );
    return;
  }
  root.appendChild(
    kind() === "explainer"
      ? coveragePanel(state.data?.coverage ?? null)
      : interfaceDelta(doc.interfaces),
  );
  const layout = h("div", { class: "doc-layout" });
  const toc = h(
    "nav",
    { class: "toc" },
    doc.toc.map((t) =>
      h(
        "a",
        {
          href: `#/review?block=${t.id}`,
          class: `l${t.level}`,
          "data-block": t.id,
          onclick: (e: Event) => {
            e.preventDefault();
            scrollToBlock(t.id);
          },
        },
        t.text,
      ),
    ),
  );
  const docEl = h("article", { class: "doc" });
  let section: HTMLElement | null = null;
  const sectionLevel = 2;
  for (const b of doc.blocks) {
    const el = renderBlock(b);
    if (b.type === "heading" && b.level === sectionLevel) {
      section = h("div", { class: `section ${b.collapsed ? "section-collapsed" : ""}` });
      docEl.appendChild(section);
      const toggle = h("span", { class: "heading-toggle" }, b.collapsed ? "show" : "hide");
      toggle.addEventListener("click", () => {
        const s = toggle.closest(".section")!;
        s.classList.toggle("section-collapsed");
        toggle.textContent = s.classList.contains("section-collapsed") ? "show" : "hide";
      });
      el.querySelector("h2,h1,h3")?.appendChild(toggle);
      el.classList.add("heading");
      section.appendChild(el);
    } else (section ?? docEl).appendChild(el);
  }
  layout.append(toc, docEl);
  root.appendChild(layout);
  selectionHandler(docEl);
  docEl.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a.anchor-link") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.dataset["anchor"]!;
    const anchor = doc.anchors[id];
    if (anchor) {
      docEl.querySelectorAll("a.anchor-link.active").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
      openAnchorPeek(anchor);
    }
  });
  const target = state.params.get("block");
  if (target) setTimeout(() => scrollToBlock(target), 50);
  const anchorParam = state.params.get("anchor");
  if (anchorParam && doc.anchors[anchorParam] && state.side.kind !== "peek")
    openAnchorPeek(doc.anchors[anchorParam]!);
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const id = (en.target as HTMLElement).dataset["block"];
        toc
          .querySelectorAll("a")
          .forEach((a) => a.classList.toggle("active", a.dataset["block"] === id));
      }
    },
    { rootMargin: "-10% 0px -80% 0px" },
  );
  docEl.querySelectorAll(".block.heading").forEach((el) => io.observe(el));
}

/** Ids the parser cannot produce, so the panel can hold threads like a document block. */
const DELTA_BLOCK = "interface-delta";
const COVERAGE_BLOCK = "coverage";
const DELTA_SHOWN = 12;

const CHANGE_CLASS: Record<InterfaceEntry["change"], string> = {
  removed: "del",
  changed: "warn",
  added: "ok",
};

/**
 * What the change did to the surfaces other code can reach, above the document
 * because it is the reader's first question. Derived at publish from the code
 * graph, so a refactor that moved nothing says exactly that.
 */
function interfaceDelta(delta: InterfaceDelta | null): HTMLElement {
  const wrap = h("div", { class: "block ifd", "data-block": DELTA_BLOCK });
  const threads = threadsFor((t) => t.type === "document" && t.blockId === DELTA_BLOCK);
  if (threads.length) wrap.classList.add("has-threads");
  // the panel has no gutter to hang the comment button in, so it lives in the head
  const actions = h(
    "div",
    { class: "block-actions" },
    h(
      "button",
      {
        class: threads.length ? "count" : "",
        title: "Comment on the interface delta",
        onclick: (e: MouseEvent) => {
          if (state.viewingRevision !== null) return;
          popover(commentPopover({ type: "document", blockId: DELTA_BLOCK }), {
            x: e.pageX + 10,
            y: e.pageY,
          });
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  const body = h("div", { class: "ifd-body" });
  const toggle = h("span", { class: "heading-toggle" }, "hide");
  toggle.addEventListener("click", () => {
    const hidden = body.hidden;
    body.hidden = !hidden;
    toggle.textContent = hidden ? "hide" : "show";
  });
  const counts = delta
    ? (["removed", "changed", "added"] as const)
        .map((c) => [c, delta.entries.filter((e) => e.change === c).length] as const)
        .filter(([, n]) => n > 0)
    : [];
  wrap.appendChild(
    h(
      "div",
      { class: "ifd-head" },
      h("span", { class: "t" }, "Interface delta"),
      counts.map(([c, n]) => h("span", { class: `badge ${CHANGE_CLASS[c]}` }, `${n} ${c}`)),
      h("span", { class: "spacer" }),
      toggle,
      actions,
    ),
  );
  body.appendChild(
    h(
      "p",
      { class: "ifd-verdict" },
      delta ? delta.verdict : "Unavailable: the code graph could not be built for these commits.",
    ),
  );
  const entries = delta?.entries ?? [];
  const rest = entries.slice(DELTA_SHOWN);
  for (const e of entries.slice(0, DELTA_SHOWN)) body.appendChild(interfaceRow(e));
  if (rest.length) {
    const more = h(
      "button",
      {
        class: "small ghost",
        onclick: () => {
          more.replaceWith(...rest.map(interfaceRow));
        },
      },
      `show ${rest.length} more`,
    );
    body.appendChild(more);
  }
  wrap.appendChild(body);
  if (threads.length)
    wrap.appendChild(h("div", { class: "thread-pins" }, threads.map(threadPinRow)));
  return wrap;
}

/**
 * What an explainer examined and what it did not, in the slot a review gives the
 * interface delta - because it is the same kind of thing: a fact derived at
 * publish from the pinned commit, above prose the agent wrote, so the reader
 * knows the bound of the document before reading a word of it.
 */
function coveragePanel(cov: Coverage | null): HTMLElement {
  const wrap = h("div", { class: "block ifd", "data-block": COVERAGE_BLOCK });
  const threads = threadsFor((t) => t.type === "document" && t.blockId === COVERAGE_BLOCK);
  if (threads.length) wrap.classList.add("has-threads");
  const actions = h(
    "div",
    { class: "block-actions" },
    h(
      "button",
      {
        class: threads.length ? "count" : "",
        title: "Comment on coverage",
        onclick: (e: MouseEvent) => {
          if (state.viewingRevision !== null) return;
          popover(commentPopover({ type: "document", blockId: COVERAGE_BLOCK }), {
            x: e.pageX + 10,
            y: e.pageY,
          });
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  const body = h("div", { class: "ifd-body" });
  const toggle = h("span", { class: "heading-toggle" }, "hide");
  toggle.addEventListener("click", () => {
    const hidden = body.hidden;
    body.hidden = !hidden;
    toggle.textContent = hidden ? "hide" : "show";
  });
  wrap.appendChild(
    h(
      "div",
      { class: "ifd-head" },
      h("span", { class: "t" }, "Coverage"),
      cov ? h("span", { class: "badge" }, `${cov.states.uncovered} not examined`) : null,
      h("span", { class: "spacer" }),
      toggle,
      actions,
    ),
  );
  body.appendChild(
    h(
      "p",
      { class: "ifd-verdict" },
      cov ? cov.verdict : "Unavailable: coverage could not be derived for this revision.",
    ),
  );
  body.appendChild(
    h(
      "p",
      { class: "ifd-verdict" },
      "A codebase does not fit in one document, so this one selects. ",
      h(
        "button",
        { class: "small", onclick: () => navigate("coverage") },
        "See what it left out ▸",
      ),
    ),
  );
  wrap.appendChild(body);
  if (threads.length)
    wrap.appendChild(h("div", { class: "thread-pins" }, threads.map(threadPinRow)));
  return wrap;
}

function interfaceRow(e: InterfaceEntry): HTMLElement {
  return h(
    "div",
    {
      class: `ifd-entry ifd-${e.change}`,
      title: "Open in Files",
      onclick: () => navigate("files", { path: e.file, line: e.line, side: e.graph }),
    },
    h("span", { class: `badge ${CHANGE_CLASS[e.change]}` }, e.change),
    h(
      "div",
      { class: "ifd-what" },
      e.was ? h("div", { class: "ifd-was" }, h("code", null, e.was)) : null,
      h("code", { class: "ifd-name" }, e.name),
      e.capability ? h("div", { class: "ifd-cap" }, e.capability) : null,
    ),
    h("span", { class: "ifd-where mono" }, `${e.file}:${e.line}`),
  );
}

function scrollToBlock(id: string): void {
  const el = document.querySelector(`[data-block="${id}"]`) as HTMLElement | null;
  if (!el) return;
  el.closest(".section")?.classList.remove("section-collapsed");
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.style.transition = "background .8s";
  el.style.background = "var(--sel)";
  setTimeout(() => (el.style.background = ""), 1200);
}

function renderBlock(b: Block): HTMLElement {
  const doc = state.data!.document!;
  const wrap = h("div", { class: "block", "data-block": b.id });
  const threads = threadsFor((t) => t.type === "document" && t.blockId === b.id);
  if (threads.length) wrap.classList.add("has-threads");
  const actions = h(
    "div",
    { class: "block-actions" },
    h(
      "button",
      {
        class: threads.length ? "count" : "",
        title: "Comment on this block",
        onclick: (e: MouseEvent) => {
          if (state.viewingRevision !== null) return;
          popover(commentPopover({ type: "document", blockId: b.id }), {
            x: e.pageX + 10,
            y: e.pageY,
          });
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  wrap.appendChild(actions);
  switch (b.type) {
    case "html":
    case "heading":
      wrap.appendChild(h("div", { html: b.html }));
      break;
    case "peek": {
      const a = doc.anchors[b.anchor];
      if (a?.peek) {
        wrap.appendChild(
          h(
            "div",
            { class: "code-frame" },
            h(
              "div",
              { class: "frame-head" },
              h("span", { class: "title" }, a.title),
              h(
                "span",
                {
                  class: "path",
                  title: "Open in Files",
                  onclick: () =>
                    navigate("files", {
                      path: a.peek!.file,
                      line: a.peek!.from,
                      side: a.peek!.graph,
                    }),
                },
                `${a.peek.file}:${a.peek.from}-${a.peek.to}`,
              ),
              h("span", { class: `badge ${a.peek.graph === "base" ? "del" : ""}` }, a.peek.graph),
              h("button", { class: "small ghost", onclick: () => openAnchorPeek(a) }, "peek ▸"),
            ),
            a.detail
              ? h(
                  "div",
                  { class: "muted", style: { padding: "4px 10px", fontSize: "12.5px" } },
                  a.detail,
                )
              : null,
            h(
              "div",
              { class: "code" },
              codeTable({
                path: a.peek.file,
                graph: a.peek.graph,
                startLine: a.peek.from,
                lines: a.peek.lines,
                commentable: true,
              }),
            ),
          ),
        );
      }
      break;
    }
    case "sequence":
      wrap.appendChild(sequenceDiagram(b));
      break;
    case "callstack":
      wrap.appendChild(callstackDiff(b, doc));
      break;
    case "database":
      wrap.appendChild(databaseLens(b, doc));
      break;
  }
  if (threads.length)
    wrap.appendChild(h("div", { class: "thread-pins" }, threads.map(threadPinRow)));
  return wrap;
}

/** Selecting text inside a block offers a comment on that block with the quote. */
function selectionHandler(docEl: HTMLElement): void {
  let btn: HTMLElement | null = null;
  const remove = () => {
    btn?.remove();
    btn = null;
  };
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return remove();
    const range = sel.getRangeAt(0);
    const block = (
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    )?.closest(".block") as HTMLElement | null;
    if (!block || !docEl.contains(block) || state.viewingRevision !== null) return remove();
    const quote = sel.toString().trim();
    if (!quote) return remove();
    const rect = range.getBoundingClientRect();
    remove();
    btn = h(
      "button",
      {
        class: "small primary selection-btn",
        onmousedown: (e: MouseEvent) => e.preventDefault(),
        onclick: (e: MouseEvent) => {
          const id = block.dataset["block"]!;
          remove();
          popover(commentPopover({ type: "document", blockId: id }, quote), {
            x: e.pageX,
            y: e.pageY + 8,
          });
          window.getSelection()?.removeAllRanges();
        },
      },
      "Comment / Ask",
    );
    btn.style.left = `${rect.left + window.scrollX}px`;
    btn.style.top = `${rect.bottom + window.scrollY + 6}px`;
    document.body.appendChild(btn);
  });
}
