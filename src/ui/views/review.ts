import { h, popover } from "../dom.js";
import { state, threadsFor, navigate } from "../state.js";
import { codeTable, openAnchorPeek } from "../code.js";
import { commentPopover, threadPinRow } from "../threads.js";
import { sequenceDiagram, callstackDiff, databaseLens } from "../diagrams.js";
import type { Block } from "../../document/compile.js";

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
