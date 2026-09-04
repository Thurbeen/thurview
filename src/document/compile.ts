import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import {
  showFile,
  lineChanges,
  listFiles,
  changedFiles,
  type ChangedFile,
  type LineChange,
} from "../git.js";
import { highlightLines, languageFor } from "../highlight.js";
import { parseDocument, type RawBlock } from "./parse.js";
import {
  DataSchema,
  SequenceSchema,
  CallstackSchema,
  DatabaseSchema,
  PeekBlockSchema,
  MapSchema,
  type Data,
  type Peek,
  type MapFile,
  type MapNode,
  type MapEdge,
} from "./schema.js";

export interface Diagnostic {
  level: "error" | "warning";
  file: string;
  line?: number;
  message: string;
}

export interface CompiledPeek extends Peek {
  lang: string;
  lines: string[];
  total: number;
}

export interface CompiledAnchor {
  id: string;
  title: string;
  detail?: string;
  map?: string;
  peek?: CompiledPeek;
}

export type Block =
  | { id: string; line: number; type: "html"; html: string }
  | {
      id: string;
      line: number;
      type: "heading";
      level: number;
      text: string;
      html: string;
      collapsed: boolean;
    }
  | { id: string; line: number; type: "peek"; anchor: string }
  | {
      id: string;
      line: number;
      type: "sequence";
      label: string;
      messages: {
        from: string;
        to: string;
        label: string;
        anchor?: string;
        code?: { language?: string; text: string };
      }[];
      actors: { id: string; label: string }[];
    }
  | {
      id: string;
      line: number;
      type: "callstack";
      title?: string;
      rows: { kind: "context" | "add" | "del"; anchor: string; calls?: boolean; reason?: string }[];
    }
  | {
      id: string;
      line: number;
      type: "database";
      title?: string;
      stores: string[];
      usecases: {
        id: string;
        label: string;
        summary?: string;
        ops: {
          op: "read" | "write";
          store: string;
          actor: string;
          label: string;
          anchor: string;
        }[];
      }[];
    };

export interface CompiledDocument {
  title: string;
  blocks: Block[];
  anchors: Record<string, CompiledAnchor>;
  actors: Data["actors"];
  stores: Data["stores"];
  toc: { id: string; level: number; text: string }[];
}

export interface CompileInput {
  cwd: string;
  pins: { base: string; head: string };
  reviewMd: string;
  dataYaml: string;
  /** registered highlighter theme name (default skin when omitted) */
  themeName?: string;
}

function zodMessages(err: unknown): string[] {
  const e = err as { issues?: { path: (string | number)[]; message: string }[] };
  if (!e.issues) return [String(err)];
  return e.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`);
}

function parseWith<T>(
  schema: ZodType<T>,
  value: unknown,
): { ok: true; value: T } | { ok: false; errors: string[] } {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: zodMessages(r.error) };
}

export async function compileDocument(input: CompileInput): Promise<{
  document: CompiledDocument | null;
  diagnostics: Diagnostic[];
  anchors: Record<string, CompiledAnchor>;
}> {
  const diags: Diagnostic[] = [];
  const err = (file: string, message: string, line?: number) =>
    diags.push({ level: "error", file, message, ...(line !== undefined ? { line } : {}) });
  const warn = (file: string, message: string, line?: number) =>
    diags.push({ level: "warning", file, message, ...(line !== undefined ? { line } : {}) });

  let dataRaw: unknown = {};
  try {
    dataRaw = parseYaml(input.dataYaml) ?? {};
  } catch (e) {
    err("data.yaml", `YAML: ${(e as Error).message}`);
  }
  const dataParsed = parseWith(DataSchema, dataRaw);
  const data: Data = dataParsed.ok ? dataParsed.value : { actors: {}, anchors: {}, stores: {} };
  if (!dataParsed.ok) for (const m of dataParsed.errors) err("data.yaml", m);

  const parsed = parseDocument(input.reviewMd);
  if (!parsed.title) err("review.md", "the document needs an H1 title");

  // Resolve anchors against the pinned commits.
  const anchors: Record<string, CompiledAnchor> = {};
  const fileCache = new Map<string, string | null>();
  const fileAt = async (graph: "head" | "base", path: string) => {
    const commit = graph === "head" ? input.pins.head : input.pins.base;
    const key = `${commit}:${path}`;
    if (!fileCache.has(key)) fileCache.set(key, await showFile(input.cwd, commit, path));
    return fileCache.get(key) ?? null;
  };
  for (const [id, a] of Object.entries(data.anchors)) {
    const out: CompiledAnchor = {
      id,
      title: a.title,
      ...(a.detail ? { detail: a.detail } : {}),
      ...(a.map ? { map: a.map } : {}),
    };
    if (a.peek) {
      const text = await fileAt(a.peek.graph, a.peek.file);
      if (text === null) {
        err(
          "data.yaml",
          `anchor ${id}: ${a.peek.file} does not exist at the pinned ${a.peek.graph} commit`,
        );
      } else {
        const lang = languageFor(a.peek.file);
        const commit = a.peek.graph === "head" ? input.pins.head : input.pins.base;
        const all = await highlightLines(text, lang, `${commit}:${a.peek.file}`, input.themeName);
        if (a.peek.to > all.length) {
          err(
            "data.yaml",
            `anchor ${id}: ${a.peek.file} has ${all.length} lines at ${a.peek.graph}, peek ends at ${a.peek.to}`,
          );
        } else {
          out.peek = {
            ...a.peek,
            lang,
            total: all.length,
            lines: all.slice(a.peek.from - 1, a.peek.to),
          };
        }
      }
    }
    anchors[id] = out;
  }
  const peekable = (id: string) => !!anchors[id]?.peek;
  const used = new Set<string>();

  for (const l of parsed.anchorLinks) {
    used.add(l.id);
    if (!anchors[l.id]) err("review.md", `anchor link to unknown anchor "${l.id}"`, l.line);
    else if (!peekable(l.id))
      err("review.md", `anchor "${l.id}" has no peek and cannot open code`, l.line);
  }

  const changes = await lineChanges(input.cwd, input.pins.base, input.pins.head);
  const blocks: Block[] = [];
  const toc: CompiledDocument["toc"] = [];

  for (const b of parsed.blocks) {
    if (b.kind === "html") {
      blocks.push({ id: b.id, line: b.line, type: "html", html: b.html! });
      continue;
    }
    if (b.kind === "heading") {
      if (b.level! >= 2) toc.push({ id: b.id, level: b.level!, text: b.text! });
      blocks.push({
        id: b.id,
        line: b.line,
        type: "heading",
        level: b.level!,
        text: b.text!,
        html: b.html!,
        collapsed: !!b.collapsed,
      });
      continue;
    }
    const block = compileComponent(b, { anchors, data, changes, used, peekable, err });
    if (block) blocks.push(block);
  }

  for (const id of Object.keys(anchors))
    if (!used.has(id)) warn("data.yaml", `anchor "${id}" is defined but never used`);

  const errors = diags.filter((d) => d.level === "error");
  if (errors.length) return { document: null, diagnostics: diags, anchors };
  return {
    document: {
      title: parsed.title,
      blocks,
      anchors,
      actors: data.actors,
      stores: data.stores,
      toc,
    },
    diagnostics: diags,
    anchors,
  };
}

interface Ctx {
  anchors: Record<string, CompiledAnchor>;
  data: Data;
  changes: Map<string, LineChange>;
  used: Set<string>;
  peekable: (id: string) => boolean;
  err: (file: string, message: string, line?: number) => void;
}

function compileComponent(b: RawBlock, ctx: Ctx): Block | null {
  const { err } = ctx;
  const where = `${b.component} block`;
  if (b.yamlError) {
    err("review.md", `${where}: YAML: ${b.yamlError}`, b.line);
    return null;
  }
  const needPeek = (id: string, what: string) => {
    ctx.used.add(id);
    if (!ctx.anchors[id])
      err("review.md", `${where}: ${what} references unknown anchor "${id}"`, b.line);
    else if (!ctx.peekable(id))
      err("review.md", `${where}: ${what} anchor "${id}" has no peek`, b.line);
  };

  if (b.component === "peek") {
    const r = parseWith(PeekBlockSchema, b.data);
    if (!r.ok) {
      for (const m of r.errors) err("review.md", `${where}: ${m}`, b.line);
      return null;
    }
    needPeek(r.value.anchor, "peek");
    return { id: b.id, line: b.line, type: "peek", anchor: r.value.anchor };
  }

  if (b.component === "sequence") {
    const r = parseWith(SequenceSchema, b.data);
    if (!r.ok) {
      for (const m of r.errors) err("review.md", `${where}: ${m}`, b.line);
      return null;
    }
    const actors: { id: string; label: string }[] = [];
    const actorId = (ref: string | { label: string }, n: number): string => {
      if (typeof ref === "string") {
        const a = ctx.data.actors[ref];
        if (!a) {
          err("review.md", `${where}: message ${n} references unknown actor "${ref}"`, b.line);
          return ref;
        }
        if (!actors.some((x) => x.id === ref)) actors.push({ id: ref, label: a.label });
        return ref;
      }
      const id = `inline:${ref.label}`;
      if (!actors.some((x) => x.id === id)) actors.push({ id, label: ref.label });
      return id;
    };
    const messages = r.value.messages.map((m, i) => {
      if (m.anchor) needPeek(m.anchor, `message ${i + 1}`);
      const code =
        m.code === undefined ? undefined : typeof m.code === "string" ? { text: m.code } : m.code;
      return {
        from: actorId(m.from, i + 1),
        to: actorId(m.to, i + 1),
        label: m.label,
        ...(m.anchor ? { anchor: m.anchor } : {}),
        ...(code ? { code } : {}),
      };
    });
    return { id: b.id, line: b.line, type: "sequence", label: r.value.label, messages, actors };
  }

  if (b.component === "callstack") {
    const r = parseWith(CallstackSchema, b.data);
    if (!r.ok) {
      for (const m of r.errors) err("review.md", `${where}: ${m}`, b.line);
      return null;
    }
    type F = { anchor: string; calls: boolean; reason?: string };
    const norm = (
      frames: (string | { calls: [string, string]; reason?: string })[],
      side: "base" | "head",
    ): F[] =>
      frames.map((f) => {
        if (typeof f === "string") {
          needPeek(f, `${side} frame`);
          return { anchor: f, calls: false };
        }
        needPeek(f.calls[0], `${side} frame`);
        needPeek(f.calls[1], `${side} frame`);
        return { anchor: f.calls[1], calls: true, ...(f.reason ? { reason: f.reason } : {}) };
      });
    const base = norm(r.value.base, "base");
    const head = norm(r.value.head, "head");
    // LCS over anchor identity
    const n = base.length;
    const m = head.length;
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i]![j] =
          base[i]!.anchor === head[j]!.anchor
            ? L[i + 1]![j + 1]! + 1
            : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    const rows: {
      kind: "context" | "add" | "del";
      anchor: string;
      calls?: boolean;
      reason?: string;
    }[] = [];
    let i = 0;
    let j = 0;
    const push = (kind: "context" | "add" | "del", f: F) =>
      rows.push({
        kind,
        anchor: f.anchor,
        ...(f.calls ? { calls: true } : {}),
        ...(f.reason ? { reason: f.reason } : {}),
      });
    while (i < n || j < m) {
      if (i < n && j < m && base[i]!.anchor === head[j]!.anchor) {
        push("context", head[j]!);
        i++;
        j++;
      } else if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) {
        push("add", head[j]!);
        j++;
      } else {
        push("del", base[i]!);
        i++;
      }
    }
    for (const row of rows) {
      const a = ctx.anchors[row.anchor];
      if (!a?.peek) continue;
      if (row.kind === "del" && a.peek.graph !== "base")
        err(
          "review.md",
          `${where}: removed frame "${row.anchor}" must use a base-graph anchor`,
          b.line,
        );
      if (row.kind !== "del" && a.peek.graph !== "head")
        err(
          "review.md",
          `${where}: head frame "${row.anchor}" must use a head-graph anchor`,
          b.line,
        );
      if (row.kind === "del" || row.kind === "add") {
        const path = a.peek.file;
        const entry =
          row.kind === "add"
            ? ctx.changes.get(path)
            : ([...ctx.changes.values()].find((c) => c.oldPath === path) ?? ctx.changes.get(path));
        const set = row.kind === "add" ? entry?.added : entry?.deleted;
        let hit = false;
        for (let l = a.peek.from; l <= a.peek.to; l++) if (set?.has(l)) hit = true;
        if (!hit)
          err(
            "review.md",
            `${where}: frame "${row.anchor}" claims ${row.kind === "add" ? "an added" : "a removed"} call but ${path}:${a.peek.from}-${a.peek.to} has no ${row.kind === "add" ? "added" : "deleted"} lines in the pinned diff`,
            b.line,
          );
      }
    }
    return {
      id: b.id,
      line: b.line,
      type: "callstack",
      ...(r.value.title ? { title: r.value.title } : {}),
      rows,
    };
  }

  if (b.component === "database") {
    const r = parseWith(DatabaseSchema, b.data);
    if (!r.ok) {
      for (const m of r.errors) err("review.md", `${where}: ${m}`, b.line);
      return null;
    }
    for (const s of r.value.stores)
      if (!ctx.data.stores[s]) err("review.md", `${where}: unknown store "${s}"`, b.line);
    for (const uc of r.value.usecases) {
      for (const op of uc.ops) {
        if (!ctx.data.actors[op.actor])
          err(
            "review.md",
            `${where}: use case ${uc.id} references unknown actor "${op.actor}"`,
            b.line,
          );
        needPeek(op.anchor, `use case ${uc.id}`);
        const [storeId, coll, field, extra] = op.store.split(".");
        const store = storeId ? ctx.data.stores[storeId] : undefined;
        const colls = store?.tables ?? store?.documents ?? {};
        if (!store || !coll || !colls[coll] || extra)
          err(
            "review.md",
            `${where}: use case ${uc.id}: unknown store path "${op.store}" (store.collection[.field])`,
            b.line,
          );
        else if (field && !colls[coll]!.schema[field])
          err(
            "review.md",
            `${where}: use case ${uc.id}: field "${field}" is not in ${storeId}.${coll}`,
            b.line,
          );
        else if (!r.value.stores.includes(storeId!))
          err(
            "review.md",
            `${where}: use case ${uc.id} uses store "${storeId}" that the block does not list`,
            b.line,
          );
      }
    }
    return {
      id: b.id,
      line: b.line,
      type: "database",
      ...(r.value.title ? { title: r.value.title } : {}),
      stores: r.value.stores,
      usecases: r.value.usecases,
    };
  }
  err("review.md", `unknown component "${b.component}"`, b.line);
  return null;
}

// ---- software map ----

export interface CompiledMap {
  head: { nodes: MapNode[]; edges: MapEdge[] };
  base: { nodes: MapNode[]; edges: MapEdge[] } | null;
  diff: { added: string[]; removed: string[]; changed: string[] };
  /** changed files (pinned diff) matched to head node ids */
  filesByNode: Record<string, string[]>;
}

export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

export async function compileMap(input: {
  cwd: string;
  pins: { base: string; head: string };
  mapYaml: string;
  anchors: Record<string, unknown>;
}): Promise<{ map: CompiledMap | null; diagnostics: Diagnostic[] }> {
  const diags: Diagnostic[] = [];
  const err = (message: string) => diags.push({ level: "error", file: "map.yaml", message });
  const warn = (message: string) => diags.push({ level: "warning", file: "map.yaml", message });
  let raw: unknown;
  try {
    raw = parseYaml(input.mapYaml);
  } catch (e) {
    err(`YAML: ${(e as Error).message}`);
    return { map: null, diagnostics: diags };
  }
  const r = parseWith(MapSchema, raw);
  if (!r.ok) {
    for (const m of r.errors) err(m);
    return { map: null, diagnostics: diags };
  }
  const m: MapFile = r.value;
  const validateGraph = async (
    g: { nodes: MapNode[]; edges: MapEdge[] },
    graph: "head" | "base",
  ) => {
    const ids = new Set<string>();
    for (const n of g.nodes) {
      if (ids.has(n.id)) err(`${graph}: duplicate node "${n.id}"`);
      ids.add(n.id);
    }
    const files = await listFiles(input.cwd, graph === "head" ? input.pins.head : input.pins.base);
    for (const n of g.nodes) {
      const parent = n.id.includes(".") ? n.id.slice(0, n.id.lastIndexOf(".")) : null;
      if (parent && !ids.has(parent))
        err(`${graph}: node "${n.id}" has no parent node "${parent}"`);
      if (n.anchor && !input.anchors[n.anchor])
        err(`${graph}: node "${n.id}" references unknown anchor "${n.anchor}"`);
      for (const glob of n.files ?? []) {
        const re = globToRegExp(glob);
        if (!files.some((f) => re.test(f)))
          warn(`${graph}: node "${n.id}": no file matches "${glob}" at the pinned ${graph} commit`);
      }
    }
    for (const e of g.edges) {
      if (!ids.has(e.from)) err(`${graph}: edge from unknown node "${e.from}"`);
      if (!ids.has(e.to)) err(`${graph}: edge to unknown node "${e.to}"`);
    }
  };
  await validateGraph(m, "head");
  if (m.base) await validateGraph(m.base, "base");
  if (diags.some((d) => d.level === "error")) return { map: null, diagnostics: diags };

  const changed: ChangedFile[] = await changedFiles(input.cwd, input.pins.base, input.pins.head);
  const filesByNode: Record<string, string[]> = {};
  for (const n of m.nodes) {
    const res = n.files?.map(globToRegExp) ?? [];
    const hits = changed.filter((f) => res.some((re) => re.test(f.path))).map((f) => f.path);
    if (hits.length) filesByNode[n.id] = hits;
  }
  const diff = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  if (m.base) {
    const baseIds = new Map(m.base.nodes.map((n) => [n.id, n]));
    const headIds = new Map(m.nodes.map((n) => [n.id, n]));
    for (const n of m.nodes) {
      const b = baseIds.get(n.id);
      if (!b) diff.added.push(n.id);
      else if (JSON.stringify(b) !== JSON.stringify(n) || filesByNode[n.id])
        diff.changed.push(n.id);
    }
    for (const n of m.base.nodes) if (!headIds.has(n.id)) diff.removed.push(n.id);
  } else {
    diff.changed = Object.keys(filesByNode);
  }
  return {
    map: {
      head: { nodes: m.nodes, edges: m.edges },
      base: m.base ? { nodes: m.base.nodes, edges: m.base.edges } : null,
      diff,
      filesByNode,
    },
    diagnostics: diags,
  };
}
