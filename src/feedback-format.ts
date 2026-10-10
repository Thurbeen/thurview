// One feedback item of the Markdown an agent reads back. Pure, with no Node
// import, so the CLI's export and a published page's own export write an item
// the same way and the two cannot drift apart.
import type { Thread } from "./store.js";

export function relative(path: string): string {
  // posix.isAbsolute or win32.isAbsolute, without node:path
  if (/^([a-zA-Z]:)?[\\/]/.test(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("export requires repository-relative anchors");
  return path;
}

export function fence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const delimiter = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${delimiter}text\n${text}\n${delimiter}`;
}

export function shortQuote(text: string): string {
  const lines = text.split("\n");
  const excerpt = lines.slice(0, 8).join("\n");
  return excerpt.slice(0, 600) + (lines.length > 8 || excerpt.length > 600 ? "\n…" : "");
}

export function codeAnchor(file: string, from: number, to: number, sha: string): string {
  return `${relative(file)}:${from}-${to} at ${sha}`;
}

/** Anchor links are reader navigation, not portable Markdown links. */
export function plainQuote(text: string): string {
  return shortQuote(text.replace(/\[([^\]]+)\]\(anchor:[^)]+\)/g, "$1"));
}

export interface ItemContext {
  target: string;
  anchors: string[];
  quote: string;
  /** a line saying where the item came from, when that is not the review store */
  origin?: string;
}

/** Item `n`'s lines, ending in a blank line. */
export function feedbackItem(n: number, t: Thread, c: ItemContext): string[] {
  const lines = [
    `### ${n}. ${t.kind === "question" ? "Question" : "Comment"} — ${t.status}`,
    "",
    `Revision: ${t.revision}`,
    `Thread: ${t.id}`,
    ...(c.origin ? [c.origin] : []),
    `Target: ${c.target}`,
  ];
  for (const a of c.anchors) lines.push(`Anchor: ${a}`);
  if (!c.anchors.length && t.target.type !== "file")
    lines.push("Anchor: none (no code anchor attached)");
  lines.push("");
  if (c.quote) lines.push("Quoted text:", "", fence(c.quote), "");
  for (const m of t.messages)
    lines.push(`${m.role === "reviewer" ? "Reviewer" : "Agent"}:`, "", fence(m.body), "");
  return lines;
}

export const checklistItem = (n: number, t: Thread): string =>
  `- [ ] Address item ${n} (thread ${t.id}).`;
