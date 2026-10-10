// Project one sealed thurview revision into the model the terminal pane draws.
//
// thurview stays the only authority: `thurview publish` has already validated
// the document, resolved every anchor against the pinned commit and written the
// result into the revision directory (`document.json`, `map.json`,
// `meta.json`). This reads those files and nothing else - no git, no compiler,
// no second copy of the rules - and turns the browser-shaped parts (HTML prose,
// highlighted code spans) into plain runs and tokens a terminal can lay out.
//
//   node node_modules/tsx/dist/cli.mjs examples/terminal-poc/project.ts <revision dir> <out.lua>
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledDocument, CompiledMap } from "../../src/document/compile.ts";

export interface Run {
  text: string;
  strong?: true;
  em?: true;
  code?: true;
  anchor?: string;
}

export interface Token {
  text: string;
  /** the highlighter's role, as thurview's own theme names it: keyword, string, comment... */
  tok: string;
}

export type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; runs: Run[]; quote?: true }
  | { t: "item"; marker: string; depth: number; runs: Run[] }
  | { t: "table"; rows: string[][] }
  | { t: "code"; lines: string[] }
  | { t: "rule" }
  | {
      t: "sequence";
      label: string;
      /** `from`/`to` are map node ids where the actor names one, else the actor's label */
      messages: { from: string; to: string; label: string; anchor?: string }[];
    }
  | {
      t: "flow";
      label: string;
      steps: { id: string; label: string; anchor?: string; decision: boolean }[];
      edges: { from: string; to: string; case?: string }[];
    }
  | { t: "peek"; anchor: string }
  /** a component the terminal does not draw yet; the pane says so rather than hiding it */
  | { t: "other"; what: string };

export interface TerminalAnchor {
  title: string;
  detail?: string;
  map?: string;
  file?: string;
  from?: number;
  to?: number;
  total?: number;
  lines: Token[][];
}

export interface TerminalNode {
  id: string;
  kind: string;
  label: string;
  description?: string;
  anchor?: string;
  status?: "added" | "changed";
}

export interface TerminalModel {
  title: string;
  kind: string;
  revision: number;
  commit: string;
  blocks: Block[];
  anchors: Record<string, TerminalAnchor>;
  map: { nodes: TerminalNode[]; edges: { from: string; to: string; label?: string }[] };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1),
      );
    return ENTITIES[e] ?? m;
  });
}

const TAG = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;

function sameStyle(a: Run, b: Run): boolean {
  return a.strong === b.strong && a.em === b.em && a.code === b.code && a.anchor === b.anchor;
}

function trim(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r })).filter((r) => r.text !== "");
  if (out[0]) out[0].text = out[0].text.trimStart();
  const last = out.at(-1);
  if (last) last.text = last.text.trimEnd();
  return out.filter((r) => r.text !== "");
}

/**
 * The prose blocks markdown-it rendered, walked back into runs. Only the tags
 * that renderer emits for a document are handled; anything else is read
 * through as its text, so an unknown tag costs its styling and never its words.
 */
export function htmlToBlocks(html: string): Block[] {
  const out: Block[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  const inline = { strong: 0, em: 0, code: 0, anchor: [] as string[] };
  let runs: Run[] | null = null;
  let quote = 0;
  let table: string[][] | null = null;
  let cell: string | null = null;
  let pre: string | null = null;

  const push = (text: string) => {
    runs ??= [];
    const run: Run = { text };
    if (inline.strong) run.strong = true;
    if (inline.em) run.em = true;
    if (inline.code) run.code = true;
    const anchor = inline.anchor.at(-1);
    if (anchor) run.anchor = anchor;
    const last = runs.at(-1);
    if (last && sameStyle(last, run)) last.text += text;
    else runs.push(run);
  };
  // An item's text ends where its own nested list begins, and again at `</li>`.
  const flushItem = () => {
    const list = lists.at(-1);
    if (runs && list) {
      const done = trim(runs);
      if (done.length)
        out.push({
          t: "item",
          marker: list.ordered ? `${list.n}.` : "•",
          depth: lists.length - 1,
          runs: done,
        });
    }
    runs = null;
  };

  for (const m of html.matchAll(TAG)) {
    const [, close, rawName, attrs = "", text] = m;
    if (text !== undefined) {
      const t = decodeEntities(text);
      if (pre !== null) pre += t;
      else if (cell !== null) cell += t;
      else if (runs || (lists.length && t.trim())) push(t.replace(/\s+/g, " "));
      continue;
    }
    const name = rawName!.toLowerCase();
    const open = !close;
    switch (name) {
      case "p":
        if (lists.length) {
          if (!open && runs) push(" ");
        } else if (open) runs = [];
        else if (runs) {
          const done = trim(runs);
          out.push(quote ? { t: "para", runs: done, quote: true } : { t: "para", runs: done });
          runs = null;
        }
        break;
      case "ul":
      case "ol":
        flushItem();
        if (open) {
          const start = /start="(\d+)"/.exec(attrs);
          lists.push({ ordered: name === "ol", n: start ? +start[1]! - 1 : 0 });
        } else lists.pop();
        break;
      case "li":
        if (open) {
          lists.at(-1)!.n++;
          runs = [];
        } else flushItem();
        break;
      case "strong":
      case "b":
        inline.strong += open ? 1 : -1;
        break;
      case "em":
      case "i":
        inline.em += open ? 1 : -1;
        break;
      case "code":
        if (pre === null) inline.code += open ? 1 : -1;
        break;
      case "a":
        if (open) inline.anchor.push(/data-anchor="([^"]+)"/.exec(attrs)?.[1] ?? "");
        else inline.anchor.pop();
        break;
      case "br":
        if (runs) push(" ");
        break;
      case "blockquote":
        quote += open ? 1 : -1;
        break;
      case "hr":
        out.push({ t: "rule" });
        break;
      case "pre":
        if (open) pre = "";
        else {
          out.push({ t: "code", lines: (pre ?? "").replace(/\n$/, "").split("\n") });
          pre = null;
        }
        break;
      case "table":
        if (open) table = [];
        else {
          out.push({ t: "table", rows: table ?? [] });
          table = null;
        }
        break;
      case "tr":
        if (open) table?.push([]);
        break;
      case "th":
      case "td":
        if (open) cell = "";
        else {
          table?.at(-1)?.push((cell ?? "").trim());
          cell = null;
        }
        break;
    }
  }
  return out;
}

/** One highlighted line of a peek - `<span style="color:var(--code-x)">` runs - as tokens. */
export function codeTokens(line: string): Token[] {
  const out: Token[] = [];
  let tok = "fg";
  for (const m of line.matchAll(TAG)) {
    const [, close, name, attrs = "", text] = m;
    if (text !== undefined) {
      const t = decodeEntities(text);
      const last = out.at(-1);
      if (last && last.tok === tok) last.text += t;
      else out.push({ text: t, tok });
    } else if (name === "span")
      tok = close ? "fg" : (/var\(--code-([a-z-]+)\)/.exec(attrs)?.[1] ?? "fg");
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function project(revisionDir: string): Promise<TerminalModel> {
  let meta: { revision: number; kind?: string; pins: { head: string } };
  let doc: CompiledDocument;
  try {
    meta = await readJson(join(revisionDir, "meta.json"));
    doc = await readJson(join(revisionDir, "document.json"));
  } catch {
    throw new Error(
      `${revisionDir} is not a published revision: it has no meta.json and document.json`,
    );
  }
  const map = await readJson<CompiledMap>(join(revisionDir, "map.json")).catch(() => null);
  const nodeOf = (actor: string) => doc.actors[actor]?.map ?? doc.actors[actor]?.label ?? actor;

  const blocks: Block[] = [];
  for (const b of doc.blocks) {
    if (b.type === "heading") blocks.push({ t: "heading", level: b.level, text: b.text });
    else if (b.type === "html") blocks.push(...htmlToBlocks(b.html));
    else if (b.type === "peek") blocks.push({ t: "peek", anchor: b.anchor });
    else if (b.type === "sequence")
      blocks.push({
        t: "sequence",
        label: b.label,
        messages: b.messages.map((m) => ({
          from: nodeOf(m.from),
          to: nodeOf(m.to),
          label: m.label,
          ...(m.anchor ? { anchor: m.anchor } : {}),
        })),
      });
    else if (b.type === "flow")
      blocks.push({
        t: "flow",
        label: b.label,
        steps: b.steps.map((s) => ({
          id: s.id,
          label: s.label,
          ...(s.anchor ? { anchor: s.anchor } : {}),
          decision: s.decision,
        })),
        edges: b.edges,
      });
    else blocks.push({ t: "other", what: b.type });
  }

  const anchors: Record<string, TerminalAnchor> = {};
  for (const [id, a] of Object.entries(doc.anchors)) {
    anchors[id] = {
      title: a.title,
      ...(a.detail ? { detail: a.detail } : {}),
      ...(a.map ? { map: a.map } : {}),
      ...(a.peek
        ? { file: a.peek.file, from: a.peek.from, to: a.peek.to, total: a.peek.total }
        : {}),
      lines: a.peek?.lines.map(codeTokens) ?? [],
    };
  }

  const added = new Set(map?.diff.added ?? []);
  const changed = new Set(map?.diff.changed ?? []);
  const status = (id: string) =>
    added.has(id)
      ? { status: "added" as const }
      : changed.has(id)
        ? { status: "changed" as const }
        : {};
  return {
    title: doc.title,
    kind: meta.kind ?? "review",
    revision: meta.revision,
    commit: meta.pins.head,
    blocks,
    anchors,
    map: {
      nodes: (map?.head.nodes ?? []).map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        ...(n.description ? { description: n.description } : {}),
        ...(n.anchor ? { anchor: n.anchor } : {}),
        ...status(n.id),
      })),
      edges: map?.head.edges ?? [],
    },
  };
}

function luaValue(value: unknown, indent: string): string {
  const inner = indent + "  ";
  if (value === null || value === undefined) return "nil";
  // JSON's escapes are Lua's too, except \uXXXX, which Lua 5.4 spells \u{XXXX}.
  if (typeof value === "string")
    return JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const entries = Array.isArray(value)
    ? value.map((v) => inner + luaValue(v, inner))
    : Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(
          ([k, v]) =>
            `${inner}${/^[A-Za-z_]\w*$/.test(k) ? k : `[${JSON.stringify(k)}]`} = ${luaValue(v, inner)}`,
        );
  return entries.length ? `{\n${entries.join(",\n")},\n${indent}}` : "{}";
}

/** The model as a Lua chunk, so the pane loads it with the host's own `require`. */
export function toLua(model: TerminalModel): string {
  return `-- Generated by examples/terminal-poc/project.ts from a sealed thurview revision.\nreturn ${luaValue(model, "")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    process.stderr.write("usage: project.ts <revision dir> <out.lua>\n");
    process.exit(2);
  }
  await writeFile(out, toLua(await project(dir)));
}
