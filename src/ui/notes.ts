// Notes a reader takes on a published copy. The copy has no server to send them
// to, so they stay in this browser, keyed to the review, revision and head they
// were written against, until the reader exports them as Markdown for an agent.
import { published } from "./published.js";
import type { Thread, ThreadTarget } from "../store.js";
import type { Block } from "../document/compile.js";
import {
  codeAnchor,
  plainQuote,
  feedbackItem,
  checklistItem,
  type ItemContext,
} from "../feedback-format.js";

const ORIGIN = "Origin: Written on a published copy; the agent has not seen it.";

const key = () => {
  const p = published!.payload;
  return `thurview.notes:${p.review.id}:${p.revision}:${p.review.pins.head}`;
};

// Read once and kept here, so blocked site data still keeps the notes for as
// long as the page is open.
let list: Thread[] | null = null;
function all(): Thread[] {
  if (!list) {
    try {
      list = JSON.parse(localStorage.getItem(key()) ?? "[]") as Thread[];
    } catch {
      list = [];
    }
  }
  return list;
}
function save(): void {
  try {
    localStorage.setItem(key(), JSON.stringify(all()));
  } catch {}
}
function find(id: string): Thread {
  const t = all().find((n) => n.id === id);
  if (!t) throw new Error("no such note in this browser");
  return t;
}
function touch(t: Thread): Thread {
  t.updatedAt = new Date().toISOString();
  save();
  return t;
}

export const isNote = (id: string): boolean => id.startsWith("note-");

export const notes = {
  list: (): Thread[] => all().map((t) => structuredClone(t)),
  add(target: ThreadTarget, body: string): Thread {
    const at = new Date().toISOString();
    const t: Thread = {
      id: `note-${Math.random().toString(16).slice(2, 10)}`,
      kind: "comment",
      mode: "review",
      status: "open",
      submitted: false,
      target,
      revision: published!.payload.revision,
      messages: [{ role: "reviewer", body, at }],
      createdAt: at,
      updatedAt: at,
    };
    all().push(t);
    save();
    return t;
  },
  reply(id: string, body: string): Thread {
    const t = find(id);
    t.messages.push({ role: "reviewer", body, at: new Date().toISOString() });
    t.status = "open";
    return touch(t);
  },
  setStatus(id: string, status: Thread["status"]): Thread {
    const t = find(id);
    t.status = status;
    return touch(t);
  },
  remove(id: string): void {
    list = all().filter((t) => t.id !== id);
    save();
  },
  /** What was sent, with this browser's notes added as further items. */
  markdown() {
    const p = published!.payload;
    const base =
      published!.feedback ??
      `# ${p.review.title}\n\n## Reader feedback\n\nNo reader feedback.\n\n## What to do\n\nNo unresolved items.\n`;
    const [head, tail = "\n"] = base.split(/\n## What to do\n/);
    const sent = (head!.match(/^### \d+\. /gm) ?? []).length;
    const items: string[] = [];
    const todo: string[] = [];
    all().forEach((t, i) => {
      items.push(...feedbackItem(sent + i + 1, t, context(t)));
      if (t.status === "open") todo.push(checklistItem(sent + i + 1, t));
    });
    const feedback = items.length
      ? `${head!.replace(/\nNo reader feedback\.\n/, "\n").trimEnd()}\n\n${items.join("\n")}`
      : head!;
    const checklist = todo.length
      ? `${tail.replace(/\nNo unresolved items\.\n/, "\n").trimEnd()}\n${todo.join("\n")}\n`
      : tail;
    const markdown = `${feedback.trimEnd()}\n\n## What to do\n${checklist}`;
    return {
      markdown,
      filename: `thurview-revision-${p.revision}.md`,
      revision: p.revision,
      threads: sent + all().length,
      open: (markdown.match(/^- \[ \] /gm) ?? []).length,
    };
  },
};

/** Where a note points, worked out from what the page carries. */
function context(t: Thread): ItemContext {
  const p = published!.payload;
  const pins = p.review.pins;
  const doc = p.document;
  const anchorOf = (id: string): string | null => {
    const peek = doc?.anchors[id]?.peek;
    return peek ? codeAnchor(peek.file, peek.from, peek.to, pins[peek.graph]) : null;
  };
  const tg = t.target;
  let target = "Review overall";
  let quote = "";
  const anchors: string[] = [];
  if (tg.type === "file") {
    const lines = published!.files[`${tg.side}:${tg.path}`]?.lines ?? [];
    target =
      tg.line > 0
        ? codeAnchor(tg.path, tg.line, tg.endLine ?? tg.line, pins[tg.side])
        : `${tg.path} (whole file) at ${pins[tg.side]}`;
    quote =
      tg.quote ?? lines.slice(Math.max(0, tg.line - 1), tg.endLine ?? (tg.line || 8)).join("\n");
  } else if (tg.type === "document") {
    const block = doc?.blocks.find((b) => b.id === tg.blockId);
    if (block) {
      target = `review.md:${block.line} (document block)`;
      quote = tg.quote ?? textOf(block);
      for (const id of anchorIds(block)) {
        const a = anchorOf(id);
        if (a) anchors.push(a);
      }
    } else if (tg.blockId === "interface-delta") {
      target = "Interface summary";
      quote = tg.quote ?? doc?.interfaces?.verdict ?? "";
      for (const e of doc?.interfaces?.entries ?? [])
        if (e.file && e.line > 0) anchors.push(codeAnchor(e.file, e.line, e.line, pins[e.graph]));
    } else if (tg.blockId === "coverage") {
      target = "Coverage summary";
      quote = tg.quote ?? p.coverage?.verdict ?? "";
    } else if (tg.blockId === "security") {
      target = "Trust boundaries summary";
      quote = tg.quote ?? doc?.security?.verdict ?? "";
      for (const c of doc?.security?.crossings ?? []) {
        const a = anchorOf(c.anchor);
        if (a) anchors.push(a);
      }
    }
  } else if (tg.type === "map") {
    const node =
      p.map?.head.nodes.find((n) => n.id === tg.node) ??
      p.map?.base?.nodes.find((n) => n.id === tg.node);
    target = `Map node: ${tg.node}`;
    quote = node?.label ?? "";
    for (const [id, a] of Object.entries(doc?.anchors ?? {})) {
      if (id !== node?.anchor && a.map !== tg.node) continue;
      const anchor = anchorOf(id);
      if (anchor && !anchors.includes(anchor)) anchors.push(anchor);
    }
  }
  return { target, anchors, quote: plainQuote(quote), origin: ORIGIN };
}

function textOf(block: Block): string {
  // Parsed inert: nothing in the author's HTML loads or runs to be quoted.
  if ("html" in block)
    return (new DOMParser().parseFromString(block.html, "text/html").body.textContent ?? "").trim();
  return "label" in block ? block.label : "";
}

/** The anchors a block links to in its prose and nests in its components. */
function anchorIds(block: Block): string[] {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [k, child] of Object.entries(value)) {
      if (k === "anchor" && typeof child === "string") ids.add(child);
      else if (k === "html" && typeof child === "string")
        for (const m of child.matchAll(/data-anchor="([^"]+)"/g)) ids.add(m[1]!);
      else collect(child);
    }
  };
  collect(block);
  return [...ids];
}
