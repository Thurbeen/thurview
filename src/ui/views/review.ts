import { h, popover, clickPoint, asButton } from "../dom.js";
import { state, threadsFor, navigate, canWrite } from "../state.js";
import { codeTable, openAnchorPeek } from "../code.js";
import { commentPopover, threadPinRow } from "../threads.js";
import { sequenceDiagram, callstackDiff, databaseLens, flowDiagram } from "../diagrams.js";
import type { Block, CompiledArchitecture, CompiledSecurity } from "../../document/compile.js";
import type { InterfaceDelta, InterfaceEntry } from "../../interfaces.js";
import {
  reportSection,
  summaryFacts,
  verdictBlock,
  findingsList,
  findingKeys,
  scopeColumns,
  landsIn,
  provenanceFacts,
} from "./report.js";

let disposeKeys: (() => void) | undefined;

/**
 * The document as a report. What a reader opening it from a pull request needs
 * comes first and in this order: what the change is, the verdict, the findings
 * with their evidence, the risks, and what was reviewed and what was not. The
 * document the agent wrote follows as the reasoning behind them.
 */
export function renderReview(root: HTMLElement): void {
  disposeKeys?.();
  disposeKeys = undefined;
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
  const verdict = state.data?.verdict ?? null;
  const first = doc.blocks.findIndex((b) => b.type === "heading" && b.level === 2);
  const landing = first < 0 ? doc.blocks : doc.blocks.slice(0, first);
  const body = first < 0 ? [] : doc.blocks.slice(first);
  const report = h("article", { class: "doc report" });

  const r = state.data!.review;
  const kicker = `Review · ${r.binding.kind === "pr" ? `pull request #${r.binding.name}` : r.binding.name}`;
  const summary = reportSection("summary", "Summary", null, h("div", { class: "kicker" }, kicker));
  // what changed, then the verdict on it, then the author's own summary
  const lede = verdict
    ? [h("p", { class: "lede" }, verdict.change), verdictBlock(verdict), summaryFacts()]
    : null;
  let placed = false;
  for (const b of landing) {
    summary.appendChild(renderBlock(b));
    if (!placed && b.type === "heading" && b.level === 1 && lede) {
      summary.append(...lede);
      placed = true;
    }
  }
  if (lede && !placed)
    lede.reverse().forEach((el) => summary.insertBefore(el, summary.children[2] ?? null));
  if (!verdict) summary.appendChild(summaryFacts());
  report.appendChild(summary);

  // A review reads as parts, each answering one question the reader brings to
  // a change, in the order they ask them.
  const parts: [string, string, string | null][] = [["report-summary", "Summary", null]];
  const add = (sec: HTMLElement, title: string, n: string | null = null) => {
    report.appendChild(sec);
    parts.push([sec.id, title, n]);
  };
  add(
    reportSection(
      "architecture",
      "Architecture",
      "where it lands, and whether it fits the design",
      verdict?.architecture ? h("p", { class: "part-lead" }, verdict.architecture) : null,
      landsIn(),
      architecturePanel(doc.architecture),
      interfaceDelta(doc.interfaces),
    ),
    "Architecture",
  );
  add(
    reportSection(
      "security",
      "Security & trust",
      "who wrote it, and what it lets in",
      verdict?.security ? h("p", { class: "part-lead" }, verdict.security) : null,
      provenanceFacts(),
      securityPanel(doc.security),
    ),
    "Security & trust",
  );
  if (verdict) {
    const n = verdict.findings.length;
    add(
      reportSection(
        "findings",
        "Findings",
        n ? `${n} to act on, most severe first` : "what to fix before merge",
        findingsList(verdict),
      ),
      "Findings",
      n ? String(n) : null,
    );
  }
  add(
    reportSection(
      "risks",
      verdict ? "Risks & evidence" : "Evidence",
      verdict
        ? "what could still break, and what the verdict rests on"
        : "what was reviewed, and what was not",
      verdict
        ? h(
            "div",
            { class: "risk-block" },
            h("h3", null, "Not ruled out"),
            h(
              "ul",
              { class: "risks" },
              verdict.risk.map((x) => h("li", null, x)),
            ),
          )
        : null,
      scopeColumns(verdict),
    ),
    verdict ? "Risks & evidence" : "Evidence",
  );

  const docSec = reportSection(
    "document",
    body.length ? "Walkthrough" : null,
    body.length ? "the change step by step, with its code" : null,
  );
  let section: HTMLElement | null = null;
  for (const b of body) {
    const el = renderBlock(b);
    if (b.type === "heading" && b.level === 2) {
      section = h("div", { class: `section ${b.collapsed ? "section-collapsed" : ""}` });
      docSec.appendChild(section);
      const s = section;
      el.querySelector("h2,h1,h3")?.appendChild(
        toggleButton(!b.collapsed, (shown) => s.classList.toggle("section-collapsed", !shown)),
      );
      el.classList.add("heading");
      section.appendChild(el);
    } else (section ?? docSec).appendChild(el);
  }
  report.appendChild(docSec);
  if (body.length) parts.push([docSec.id, "Walkthrough", null]);

  const entries = parts;
  const link = (id: string, text: string, cls: string, n: string | null) =>
    h(
      "a",
      {
        href: `#/review?block=${id}`,
        class: cls,
        "data-block": id,
        onclick: (e: Event) => {
          e.preventDefault();
          scrollToBlock(id);
        },
      },
      h("span", null, text),
      n ? h("span", { class: "n" }, n) : null,
    );
  const toc = h(
    "nav",
    { class: "toc", "aria-label": "On this page" },
    h("div", { class: "toc-label" }, "On this page"),
    entries.map(([id, text, n]) => link(id, text, "l2", n)),
    doc.toc.map((t) => link(t.id, t.text, `l${t.level + 1}`, null)),
  );
  // On a phone the rail is gone; the same sections sit in a strip that scrolls with the page.
  const jump = h(
    "nav",
    { class: "jump", "aria-label": "Jump to" },
    entries.slice(1).map(([id, text, n]) => link(id, n ? `${text} ${n}` : text, "", null)),
  );
  root.appendChild(jump);
  const layout = h("div", { class: "doc-layout" });
  layout.append(toc, report);
  root.appendChild(layout);
  selectionHandler(report);
  report.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a.anchor-link") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.dataset["anchor"]!;
    const anchor = doc.anchors[id];
    if (anchor) {
      report.querySelectorAll("a.anchor-link.active").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
      openAnchorPeek(anchor);
    }
  });
  disposeKeys = findingKeys(report);
  const target = state.params.get("block");
  if (target) setTimeout(() => scrollToBlock(target), 50);
  const anchorParam = state.params.get("anchor");
  if (anchorParam && doc.anchors[anchorParam] && state.side.kind !== "peek")
    openAnchorPeek(doc.anchors[anchorParam]!);
  trackSection(root, toc, report);
}

/**
 * Mark in the contents the last heading above the top quarter of the view - the
 * section being read. Worked out from positions on every scroll, so a jump from
 * a link or a fast scroll lands on the right entry as surely as a slow one, and
 * a subsection is marked as well as a section. Across the last screen the line
 * moves down to the bottom, so a section too near the end to reach the top
 * quarter is still marked once the reader is there.
 */
function trackSection(scroller: HTMLElement, toc: HTMLElement, docEl: HTMLElement): void {
  const links = [...toc.querySelectorAll<HTMLAnchorElement>("a")];
  const heads = links.map((a) =>
    docEl.querySelector<HTMLElement>(`[data-block="${a.dataset["block"]}"]`),
  );
  let queued = false;
  const mark = () => {
    queued = false;
    if (!docEl.isConnected) return scroller.removeEventListener("scroll", onScroll);
    const view = scroller.getBoundingClientRect();
    // How far through the scroll's last screen the reader is: a document
    // shorter than two views starts inside it, so it is measured against what
    // there is to scroll, and one that does not scroll at all never moves it.
    const room = scroller.scrollHeight - scroller.clientHeight;
    const last = Math.min(scroller.clientHeight, room);
    const end = last > 0 ? Math.max(0, 1 - (room - scroller.scrollTop) / last) : 0;
    const line = view.top + view.height * (0.25 + 0.75 * end);
    let at = -1;
    heads.forEach((el, i) => {
      // a heading in a hidden section has no box, and is not being read
      if (el?.getClientRects().length && el.getBoundingClientRect().top <= line) at = i;
    });
    links.forEach((a, i) => a.classList.toggle("active", i === at));
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  requestAnimationFrame(mark);
}

/** Ids the parser cannot produce, so the panel can hold threads like a document block. */
const DELTA_BLOCK = "interface-delta";
const SECURITY_BLOCK = "security";
const ARCHITECTURE_BLOCK = "architecture";
const DELTA_SHOWN = 12;

const CHANGE_CLASS: Record<InterfaceEntry["change"], string> = {
  removed: "del",
  changed: "warn",
  added: "ok",
};

/**
 * What the change did to the surfaces other code can reach, above the document
 * because it is the reader's first question. Declared by the author and held
 * at publish to anchors on lines the diff moved, so it cannot claim a change
 * the code did not make.
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
          if (!canWrite()) return;
          popover(commentPopover({ type: "document", blockId: DELTA_BLOCK }), clickPoint(e));
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  const body = h("div", { class: "ifd-body" });
  const toggle = toggleButton(true, (shown) => (body.hidden = !shown));
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
      delta ? delta.verdict : "Unavailable: this revision recorded no interface delta.",
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
 * A dimension of the review the author answers in data.yaml - the architecture
 * and the trust boundaries - stated above the prose in one sentence, with each
 * entry opening its anchored code. The panel is never absent, so silence cannot
 * pass for an answer: a review that has not looked says so here.
 */
function dimensionPanel(p: {
  blockId: string;
  title: string;
  badge: HTMLElement | null;
  verdict: string;
  /** the author's own words under the verdict, when the dimension carries them */
  view?: string;
  entries: { lines: string[]; anchor: string }[];
}): HTMLElement {
  const wrap = h("div", { class: "block ifd", "data-block": p.blockId });
  const threads = threadsFor((t) => t.type === "document" && t.blockId === p.blockId);
  if (threads.length) wrap.classList.add("has-threads");
  const actions = h(
    "div",
    { class: "block-actions" },
    h(
      "button",
      {
        class: threads.length ? "count" : "",
        title: `Comment on the ${p.title.toLowerCase()}`,
        onclick: (e: MouseEvent) => {
          if (!canWrite()) return;
          popover(commentPopover({ type: "document", blockId: p.blockId }), clickPoint(e));
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  const body = h("div", { class: "ifd-body" });
  const toggle = toggleButton(true, (shown) => (body.hidden = !shown));
  wrap.appendChild(
    h(
      "div",
      { class: "ifd-head" },
      h("span", { class: "t" }, p.title),
      p.badge,
      h("span", { class: "spacer" }),
      toggle,
      actions,
    ),
  );
  body.appendChild(h("p", { class: "ifd-verdict" }, p.verdict));
  if (p.view) body.appendChild(h("p", { class: "ifd-cap" }, p.view));
  for (const entry of p.entries) {
    const anchor = state.data?.document?.anchors[entry.anchor];
    if (!anchor) continue;
    body.appendChild(
      asButton(
        h(
          "div",
          {
            class: "ifd-entry",
            title: `Open ${anchor.title}`,
            onclick: () => openAnchorPeek(anchor),
          },
          h(
            "div",
            { class: "ifd-what" },
            entry.lines.map((l) => h("div", { class: "ifd-cap" }, l)),
          ),
          h(
            "span",
            { class: "ifd-where mono" },
            anchor.peek ? `${anchor.peek.file}:${anchor.peek.from}` : anchor.title,
          ),
        ),
      ),
    );
  }
  wrap.appendChild(body);
  if (threads.length)
    wrap.appendChild(h("div", { class: "thread-pins" }, threads.map(threadPinRow)));
  return wrap;
}

/**
 * The view the review takes on the design, first in the scope because a defect
 * there outlives every bug it causes. Each defect opens the code it names.
 */
function architecturePanel(arch: CompiledArchitecture | null | undefined): HTMLElement {
  return dimensionPanel({
    blockId: ARCHITECTURE_BLOCK,
    title: "Architecture",
    badge: !arch
      ? null
      : arch.state === "fits"
        ? h("span", { class: "badge ok" }, "fits")
        : arch.state === "pending"
          ? h("span", { class: "badge warn" }, "not assessed")
          : h(
              "span",
              { class: "badge del" },
              `${arch.defects.length} defect${arch.defects.length === 1 ? "" : "s"}`,
            ),
    verdict: arch ? arch.verdict : "Unavailable: this revision carries no architecture dimension.",
    ...(arch?.view ? { view: arch.view } : {}),
    entries: (arch?.defects ?? []).map((d) => ({
      lines: [d.cause, `Target: ${d.target}`, `Step: ${d.step}`],
      anchor: d.anchor,
    })),
  });
}

/**
 * Where the change lets input cross a trust boundary, under the interface delta
 * because it is the same kind of fact: what this change did to something the
 * reader cares about, in one sentence, before the prose.
 */
function securityPanel(sec: CompiledSecurity | null | undefined): HTMLElement {
  return dimensionPanel({
    blockId: SECURITY_BLOCK,
    title: "Trust boundaries",
    badge: !sec
      ? null
      : sec.state === "none"
        ? h("span", { class: "badge ok" }, "none")
        : sec.state === "pending"
          ? h("span", { class: "badge warn" }, "not assessed")
          : h("span", { class: "badge warn" }, `${sec.crossings.length} crossed`),
    verdict: sec ? sec.verdict : "Unavailable: this revision carries no security dimension.",
    entries: (sec?.crossings ?? []).map((c) => ({ lines: [c.boundary], anchor: c.anchor })),
  });
}

function interfaceRow(e: InterfaceEntry): HTMLElement {
  const row = h(
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
  return asButton(row);
}

/** The hide/show switch on a section or a panel: a button, so the keyboard reaches it too. */
function toggleButton(shown: boolean, set: (shown: boolean) => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: "heading-toggle" });
  const show = (on: boolean) => {
    b.setAttribute("aria-expanded", String(on));
    b.textContent = on ? "hide" : "show";
  };
  show(shown);
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-expanded") !== "true";
    show(on);
    set(on);
  });
  return b;
}

function scrollToBlock(id: string): void {
  // Only in the document: the links that jump here carry the same data-block.
  const el = document.querySelector<HTMLElement>(`article.report [data-block="${id}"]`);
  if (!el) return;
  el.closest(".section")?.classList.remove("section-collapsed");
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  // a part takes the focus too, so the keyboard carries on from where the link went
  if (el.classList.contains("report-section")) el.focus({ preventScroll: true });
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
          if (!canWrite()) return;
          popover(commentPopover({ type: "document", blockId: b.id }), clickPoint(e));
        },
      },
      threads.length ? String(threads.length) : "+",
    ),
  );
  wrap.appendChild(actions);
  switch (b.type) {
    case "html":
    case "heading":
      wrap.appendChild(h("div", { class: "prose", html: b.html }));
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
    case "flow":
      wrap.appendChild(flowDiagram(b, doc));
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
    if (!block || !docEl.contains(block) || !canWrite()) return remove();
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
