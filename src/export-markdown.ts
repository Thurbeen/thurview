import { basename, join, posix, win32 } from "node:path";
import {
  readJson,
  readText,
  readThreads,
  revisionDir,
  kindOf,
  type ReviewState,
  type Binding,
  type Thread,
} from "./store.js";
import { parseDocument } from "./document/parse.js";
import type { CompiledDocument, CompiledMap, Block } from "./document/compile.js";
import type { Coverage } from "./coverage.js";
import { showFile, type ChangedFile } from "./git.js";

interface Meta {
  title: string;
  pins: ReviewState["pins"];
  binding?: Binding;
}

async function sealed(review: ReviewState, n: number) {
  const dir = revisionDir(review.id, n);
  const [meta, document, source, map, changes, coverage] = await Promise.all([
    readJson<Meta>(join(dir, "meta.json")),
    readJson<CompiledDocument>(join(dir, "document.json")),
    readText(join(dir, "review.md")),
    readJson<CompiledMap>(join(dir, "map.json")),
    readJson<ChangedFile[]>(join(dir, "changes.json")),
    readJson<Coverage>(join(dir, "coverage.json")),
  ]);
  if (!meta || !document || source === null) throw new Error(`sealed revision ${n} is unavailable`);
  return {
    meta,
    coverage,
    document,
    source,
    map,
    changes: changes ?? [],
    parsed: parseDocument(source),
  };
}
type Sealed = Awaited<ReturnType<typeof sealed>>;

function relative(path: string): string {
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("export requires repository-relative anchors");
  return path;
}

function fence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const delimiter = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${delimiter}text\n${text}\n${delimiter}`;
}

function shortQuote(text: string): string {
  const lines = text.split("\n");
  const excerpt = lines.slice(0, 8).join("\n");
  return excerpt.slice(0, 600) + (lines.length > 8 || excerpt.length > 600 ? "\n…" : "");
}

function codeAnchor(file: string, from: number, to: number, sha: string): string {
  return `${relative(file)}:${from}-${to} at ${sha}`;
}

function blockAnchors(block: Block, snapshot: Sealed): string[] {
  const ids = new Set(
    snapshot.parsed.anchorLinks.filter((a) => a.line === block.line).map((a) => a.id),
  );
  // Components nest their anchors in messages, steps, rows and operations.
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "anchor" && typeof child === "string") ids.add(child);
      else collect(child);
    }
  };
  collect(block);
  return [...ids];
}

function position(thread: Thread, s: Sealed): [number, number, string, number] {
  const t = thread.target;
  if (t.type === "document") {
    if (t.blockId === "interface-delta" || t.blockId === "coverage") return [0, -2, "", 0];
    if (t.blockId === "security") return [0, -1, "", 0];
    const index = s.document.blocks.findIndex((b) => b.id === t.blockId);
    return [0, index < 0 ? Number.MAX_SAFE_INTEGER : index, "", 0];
  }
  if (t.type === "file") {
    const index = s.changes.findIndex((f) => f.path === t.path || f.oldPath === t.path);
    return [1, index < 0 ? Number.MAX_SAFE_INTEGER : index, t.path, t.line];
  }
  if (t.type === "map") {
    const index = s.map?.head.nodes.findIndex((n) => n.id === t.node) ?? -1;
    return [2, index < 0 ? Number.MAX_SAFE_INTEGER : index, t.node, 0];
  }
  return [3, 0, "", 0];
}

async function context(thread: Thread, snapshot: Sealed, review: ReviewState) {
  const t = thread.target;
  const pins = snapshot.meta.pins;
  const anchors: string[] = [];
  let quote = "";
  let target = "Document overall";
  if (t.type === "file") {
    const path = relative(t.path);
    const sha = pins[t.side];
    target =
      t.line > 0
        ? codeAnchor(path, t.line, t.endLine ?? t.line, sha)
        : `${path} (whole file) at ${sha}`;
    const text = await showFile(review.worktree, sha, path);
    quote =
      t.quote ??
      (text === null
        ? ""
        : text
            .split("\n")
            .slice(Math.max(0, t.line - 1), t.endLine ?? (t.line || 8))
            .join("\n"));
  } else if (t.type === "document") {
    const block = snapshot.document.blocks.find((b) => b.id === t.blockId);
    if (block) {
      target = `review.md:${block.line} (document block)`;
      const next = snapshot.document.blocks.find((b) => b.line > block.line)?.line;
      quote =
        t.quote ??
        snapshot.source
          .split("\n")
          .slice(block.line - 1, next ? next - 1 : undefined)
          .join("\n")
          .trim();
      for (const id of blockAnchors(block, snapshot)) {
        const peek = snapshot.document.anchors[id]?.peek;
        if (peek) anchors.push(codeAnchor(peek.file, peek.from, peek.to, pins[peek.graph]));
      }
    } else if (t.blockId === "interface-delta") {
      target = "Interface summary";
      quote = t.quote ?? snapshot.document.interfaces?.verdict ?? "Interface summary unavailable.";
      for (const entry of snapshot.document.interfaces?.entries ?? []) {
        if (entry.file && entry.line > 0)
          anchors.push(codeAnchor(entry.file, entry.line, entry.line, pins[entry.graph]));
      }
    } else if (t.blockId === "coverage") {
      target = "Coverage summary";
      quote = t.quote ?? snapshot.coverage?.verdict ?? "Coverage summary unavailable.";
    } else if (t.blockId === "security") {
      target = "Trust boundaries summary";
      quote = t.quote ?? snapshot.document.security?.verdict ?? "Trust boundaries not assessed.";
      for (const crossing of snapshot.document.security?.crossings ?? []) {
        const p = snapshot.document.anchors[crossing.anchor]?.peek;
        if (p) anchors.push(codeAnchor(p.file, p.from, p.to, pins[p.graph]));
      }
    } else {
      target = "Document block (unavailable in its sealed revision)";
      quote = t.quote ?? "";
    }
  } else if (t.type === "map") {
    const node =
      snapshot.map?.head.nodes.find((n) => n.id === t.node) ??
      snapshot.map?.base?.nodes.find((n) => n.id === t.node);
    target = `Map node: ${t.node}`;
    quote = node?.label ?? "";
    const nodePeek = node?.anchor ? snapshot.document.anchors[node.anchor]?.peek : undefined;
    if (nodePeek)
      anchors.push(codeAnchor(nodePeek.file, nodePeek.from, nodePeek.to, pins[nodePeek.graph]));
    for (const a of Object.values(snapshot.document.anchors)) {
      if (a.map === t.node && a.peek) {
        const p = a.peek;
        const anchor = codeAnchor(p.file, p.from, p.to, pins[p.graph]);
        if (!anchors.includes(anchor)) anchors.push(anchor);
      }
    }
  }
  // Anchor links are reader navigation, not portable Markdown links.
  quote = quote.replace(/\[([^\]]+)\]\(anchor:[^)]+\)/g, "$1");
  return { target, anchors, quote: shortQuote(quote) };
}

export async function exportMarkdown(review: ReviewState, revision = review.revision) {
  if (!Number.isInteger(revision) || revision < 1 || revision > review.revision)
    throw new Error("export requires a published revision between 1 and the current revision");
  const snapshots = new Map<number, Sealed>();
  const current = await sealed(review, revision);
  snapshots.set(revision, current);
  const feedback = await readThreads(review.id);
  const threads = feedback.threads.filter((t) => t.revision <= revision);
  for (const t of threads) {
    if (!snapshots.has(t.revision)) snapshots.set(t.revision, await sealed(review, t.revision));
  }
  threads.sort((a, b) => {
    if (a.revision !== b.revision) return a.revision - b.revision;
    const x = position(a, snapshots.get(a.revision)!);
    const y = position(b, snapshots.get(b.revision)!);
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    }
    return 0;
  });
  const meta = current.meta;
  const binding = meta.binding ?? review.binding;
  const name =
    binding.kind === "range" ? `${meta.pins.base}..${meta.pins.head}` : relative(binding.name);
  const lines = [
    `# ${meta.title}`,
    "",
    `- Repository: ${basename(review.repoRoot)}`,
    `- Document: ${kindOf(review)}`,
    `- Reviewed: ${binding.kind} ${name}`,
    `- Revision: ${revision}`,
    ...(kindOf(review) === "review"
      ? [`- Base: ${meta.pins.base}`, `- Head: ${meta.pins.head}`]
      : [`- Commit: ${meta.pins.head}`]),
    "",
    "## Verdict",
    "",
  ];
  const decisions = feedback.decisions.filter((d) => d.revision <= revision);
  const labels = {
    approve: "Approve",
    "request-changes": "Request changes",
    close: "Sent back (closed without approval)",
  };
  if (!decisions.length) lines.push("No verdict given.", "");
  for (const d of decisions) {
    lines.push(`${labels[d.decision]} (revision ${d.revision})`, "");
    if (d.body) lines.push(fence(d.body), "");
  }
  lines.push("## Reader feedback", "");
  if (!threads.length) lines.push("No reader feedback.", "");
  const checklist: string[] = [];
  for (const [i, t] of threads.entries()) {
    const c = await context(t, snapshots.get(t.revision)!, review);
    lines.push(
      `### ${i + 1}. ${t.kind === "question" ? "Question" : "Comment"} — ${t.status}`,
      "",
      `Revision: ${t.revision}`,
      `Thread: ${t.id}`,
      `Target: ${c.target}`,
    );
    for (const a of c.anchors) lines.push(`Anchor: ${a}`);
    if (!c.anchors.length && t.target.type !== "file")
      lines.push("Anchor: none (no code anchor attached)");
    lines.push("");
    if (c.quote) lines.push("Quoted text:", "", fence(c.quote), "");
    for (const m of t.messages)
      lines.push(`${m.role === "reviewer" ? "Reviewer" : "Agent"}:`, "", fence(m.body), "");
    if (t.status === "open") {
      checklist.push(`- [ ] Address item ${i + 1} (thread ${t.id}).`);
    }
  }
  lines.push("## What to do", "", ...(checklist.length ? checklist : ["No unresolved items."]), "");
  return {
    markdown: lines.join("\n"),
    filename: `thurview-revision-${revision}.md`,
    revision,
    threads: threads.length,
    open: checklist.length,
  };
}
