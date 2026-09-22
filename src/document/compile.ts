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
import { parseDocument, FOREIGN_DIAGRAM_FENCES, type RawBlock } from "./parse.js";
import { withVerdict, sortEntries, type InterfaceDelta } from "../interfaces.js";
import type { DocumentKind } from "../store.js";
import {
  DataSchema,
  SequenceSchema,
  CallstackSchema,
  DatabaseSchema,
  FlowSchema,
  PeekBlockSchema,
  MapSchema,
  CrossingListSchema,
  type Data,
  type Security,
  type Crossing,
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
    }
  | {
      id: string;
      line: number;
      type: "flow";
      label: string;
      /** declaration order; the first is the entry the rest must be reachable from */
      steps: { id: string; label: string; actor?: string; anchor?: string; decision: boolean }[];
      edges: { from: string; to: string; case?: string }[];
    };

/**
 * The security dimension: where this change lets input cross a trust boundary,
 * stated by the author and anchored like every other claim in the document.
 * `pending` is a document that has not looked, `none` one that looked and found
 * nothing - and the reader is shown which of the two it is, because a silence
 * that could be either is worth nothing the next time.
 */
export interface CompiledSecurity {
  state: "pending" | "none" | "crossings";
  crossings: { boundary: string; anchor: string }[];
  /** the whole answer in one sentence, for the agent and the reader alike */
  verdict: string;
}

export interface CompiledDocument {
  title: string;
  blocks: Block[];
  /** derived from the pinned commits, with the agent's capability lines merged in */
  interfaces: InterfaceDelta | null;
  /** review only: an explainer and a design have no change to cross a boundary */
  security: CompiledSecurity | null;
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
  /** review (a change), explainer (a codebase at one commit) or design (a proposal); default review */
  kind?: DocumentKind;
  /** registered highlighter theme name (default skin when omitted) */
  themeName?: string;
  /** the derived interface delta; null when the code graph could not be built */
  interfaces?: InterfaceDelta | null;
}

/** The kind, as a message names it, so one sentence serves every kind that needs it. */
function kindWord(kind: DocumentKind): string {
  return kind === "explainer" ? "an explainer" : kind === "design" ? "a design" : "a review";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  const data: Data = dataParsed.ok
    ? dataParsed.value
    : { actors: {}, anchors: {}, stores: {}, interfaces: {} };
  if (!dataParsed.ok) for (const m of dataParsed.errors) err("data.yaml", m);

  const kind: DocumentKind = input.kind ?? "review";
  if (kind === "explainer" && Object.keys(data.interfaces).length)
    err(
      "data.yaml",
      "an explainer has no interface delta: it explains a codebase at one commit, not a change",
    );
  // A trust boundary is something a CHANGE carries input across, so the
  // dimension belongs to the kind that has one. An explainer and a design are
  // pinned to a single commit, and a crossing declared against one would be a
  // statement about code nobody touched. The KEY is what they cannot carry, not
  // one of its values: leaving `security: pending` through would make the
  // documents' "an explainer has no such key" false, and the author is being
  // told to delete the key, not to pick a better value for it.
  if (kind !== "review" && isRecord(dataRaw) && "security" in dataRaw)
    err(
      "data.yaml",
      `security is what a change crosses: ${kindWord(kind)} is pinned to one commit and has no diff, so it has none of its own to state`,
    );
  // A design has no diff, so nothing derives a row for the agent to annotate.
  // Every entry it declares is a proposal, and it has to name its own interface.
  if (kind === "design")
    for (const [key, e] of Object.entries(data.interfaces))
      if (e.symbol)
        err(
          "data.yaml",
          `interface ${key}: a design proposes an interface, it does not annotate one the code graph derived; name it with \`name\`, \`change\` and \`anchor\``,
        );

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
    if (a.peek && kind !== "review" && a.peek.graph === "base") {
      err(
        "data.yaml",
        `anchor ${id}: ${kindWord(kind)} has one pinned commit, so \`graph: base\` has no meaning`,
      );
    } else if (a.peek) {
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

  const interfaces =
    kind === "explainer"
      ? null
      : kind === "design"
        ? compileProposals({ declared: data.interfaces, anchors, used, err })
        : compileInterfaces({
            delta: input.interfaces ?? null,
            declared: data.interfaces,
            anchors,
            changes,
            used,
            err,
            warn,
          });

  // Two questions, and only one of them needs the rest of data.yaml. The SHAPE
  // of `security` is read from the raw file, so a mistake in it is reported
  // beside a mistake elsewhere rather than one publish later. Resolving a
  // crossing against `anchors` is the other: when the file did not parse those
  // came from the fallback, and every crossing would be blamed for naming an
  // anchor that is not missing, only unknown.
  const declaredSecurity = kind === "review" ? parseSecurity(dataRaw, used, err) : "pending";
  const security =
    kind === "review"
      ? compileSecurity({
          declared: dataParsed.ok ? declaredSecurity : "pending",
          anchors,
          declaredAnchors: data.anchors,
          used,
          err,
        })
      : null;

  for (const id of Object.keys(anchors))
    if (!used.has(id)) warn("data.yaml", `anchor "${id}" is defined but never used`);

  // A review may publish a stub so the reader can read the diff while the
  // walkthrough is written. An explainer has no diff to read in the meantime,
  // so an unanchored one is only prose about code the reader cannot check.
  if (kind === "explainer" && !used.size)
    err(
      "review.md",
      "an explainer needs at least one anchored claim: link prose to code with [text](anchor:<id>)",
    );

  // What separates a design from an explainer is that it proposes something.
  // Without a proposal it is prose about the code as it stands, which is the
  // other kind, and the reader would be asked to approve a plan with no plan.
  if (kind === "design" && !interfaces?.entries.length)
    err(
      "data.yaml",
      "this design proposes nothing: declare under `interfaces` what it would add, change or remove, each with the anchor of the code it lands in today",
    );

  const errors = diags.filter((d) => d.level === "error");
  if (errors.length) return { document: null, diagnostics: diags, anchors };
  return {
    document: {
      title: parsed.title,
      blocks,
      interfaces,
      security,
      anchors,
      actors: data.actors,
      stores: data.stores,
      toc,
    },
    diagnostics: diags,
    anchors,
  };
}

/**
 * Read `security` out of the raw YAML, so a value it cannot read is reported as
 * itself. Going through `DataSchema` instead would cost the path - zod erases
 * it across a union - and, because a failed parse discards the whole file, it
 * would report every anchor in `data.yaml` as undefined on top. The author
 * would then be sent to fix anchors that are correct.
 */
function parseSecurity(
  raw: unknown,
  used: Set<string>,
  err: (file: string, message: string) => void,
): Security {
  const v = isRecord(raw) ? raw["security"] : undefined;
  if (v === undefined) return "pending";
  if (v === "pending" || v === "none") return v;
  if (Array.isArray(v)) {
    // One bad entry rejects the list, but the good entries still name their
    // anchors and those anchors are still used. Without this, a typo in the
    // last crossing reports every anchor above it as defined and never used.
    for (const e of v) if (isRecord(e) && typeof e["anchor"] === "string") used.add(e["anchor"]);
    const r = parseWith(CrossingListSchema, v);
    if (r.ok) return r.value;
    for (const m of r.errors) {
      // zod paths an entry by its index; the messages below count from one
      const at = /^(\d+)(?:\.|: )/.exec(m);
      err(
        "data.yaml",
        at ? `security crossing ${Number(at[1]) + 1}: ${m.slice(at[0].length)}` : `security: ${m}`,
      );
    }
    return "pending";
  }
  err(
    "data.yaml",
    "security: write `none` to say the change crosses no trust boundary, or list the crossings",
  );
  return "pending";
}

/**
 * Resolve the security dimension against the anchors the document already has.
 *
 * A crossing is a claim about the change as it stands at head, so it takes a
 * head anchor with a peek and nothing else will do: an anchor that opens
 * nothing is how a reader stops trusting the ones that open something, and the
 * rest of the document lives under the same rule. Resolving one also marks the
 * anchor used, so the dimension needs no prose link to earn its anchor.
 */
function compileSecurity(ctx: {
  declared: Security;
  anchors: Record<string, CompiledAnchor>;
  /** what data.yaml asked for, to tell a peek that is missing from one that failed */
  declaredAnchors: Data["anchors"];
  used: Set<string>;
  err: (file: string, message: string) => void;
}): CompiledSecurity {
  if (ctx.declared === "pending" || ctx.declared === "none")
    return {
      state: ctx.declared,
      crossings: [],
      verdict:
        ctx.declared === "none"
          ? "No trust boundary crossed."
          : "Not assessed: this revision does not say whether the change crosses a trust boundary.",
    };
  const crossings: CompiledSecurity["crossings"] = [];
  ctx.declared.forEach((c: Crossing, i: number) => {
    const where = `security crossing ${i + 1}`;
    ctx.used.add(c.anchor);
    const anchor = ctx.anchors[c.anchor];
    if (!anchor) return ctx.err("data.yaml", `${where}: unknown anchor "${c.anchor}"`);
    if (!anchor.peek) {
      // A peek that was written but could not be resolved already has its own
      // error, and the actionable one is that one. Saying "no peek" over it
      // sends the author to add what is in front of them.
      if (!ctx.declaredAnchors[c.anchor]?.peek)
        ctx.err(
          "data.yaml",
          `${where}: anchor "${c.anchor}" has no peek, so the reader cannot open the code it names`,
        );
      return;
    }
    if (anchor.peek.graph !== "head")
      return ctx.err(
        "data.yaml",
        `${where}: anchor "${c.anchor}" reads the base commit; a crossing is the boundary as the change leaves it, so it takes a head anchor`,
      );
    crossings.push({ boundary: c.boundary, anchor: c.anchor });
  });
  const n = crossings.length;
  return {
    state: "crossings",
    crossings,
    verdict: `${n} trust boundar${n === 1 ? "y" : "ies"} crossed.`,
  };
}

/**
 * Merge what the agent wrote into what the graph derived. A capability line
 * must attach to an entry the change really moved, and an interface the graph
 * cannot see must be proved by an anchor on the diff's own added or deleted
 * lines, so neither can be manufactured or outlive the code.
 */
function compileInterfaces(ctx: {
  delta: InterfaceDelta | null;
  declared: Data["interfaces"];
  anchors: Record<string, CompiledAnchor>;
  changes: Map<string, LineChange>;
  used: Set<string>;
  err: (file: string, message: string) => void;
  warn: (file: string, message: string) => void;
}): InterfaceDelta | null {
  const declared = Object.entries(ctx.declared);
  if (!ctx.delta) {
    if (declared.length)
      ctx.warn("data.yaml", "the code graph is unavailable, so interfaces was not applied");
    return null;
  }
  const delta: InterfaceDelta = { ...ctx.delta, entries: [...ctx.delta.entries] };
  for (const [key, e] of declared) {
    if (e.symbol) {
      const row = delta.entries.find((x) => x.id === e.symbol);
      if (!row)
        ctx.err(
          "data.yaml",
          `interface ${key}: no interface change for symbol "${e.symbol}"; run \`thurview graph interfaces\` for the ids this change moved`,
        );
      else row.capability = e.capability;
      continue;
    }
    const anchor = ctx.anchors[e.anchor!];
    ctx.used.add(e.anchor!);
    if (!anchor) {
      ctx.err("data.yaml", `interface ${key}: unknown anchor "${e.anchor}"`);
      continue;
    }
    if (!anchor.peek) {
      ctx.err("data.yaml", `interface ${key}: anchor "${e.anchor}" has no peek`);
      continue;
    }
    const removed = e.change === "removed";
    const side = removed ? "base" : "head";
    if (anchor.peek.graph !== side) {
      ctx.err(
        "data.yaml",
        `interface ${key}: a ${e.change} interface must use a ${side}-graph anchor`,
      );
      continue;
    }
    const path = anchor.peek.file;
    const entry = removed
      ? ([...ctx.changes.values()].find((c) => c.oldPath === path) ?? ctx.changes.get(path))
      : ctx.changes.get(path);
    const lines = removed ? entry?.deleted : entry?.added;
    let proven = false;
    for (let l = anchor.peek.from; l <= anchor.peek.to; l++) if (lines?.has(l)) proven = true;
    if (!proven) {
      ctx.err(
        "data.yaml",
        `interface ${key}: anchor "${e.anchor}" (${path}:${anchor.peek.from}-${anchor.peek.to}) has no ${removed ? "deleted" : "added"} lines in the pinned diff, so it does not show a ${e.change} interface`,
      );
      continue;
    }
    delta.entries.push({
      id: `authored:${key}`,
      change: e.change!,
      name: e.name!,
      was: "",
      kind: "declared",
      file: path,
      line: anchor.peek.from,
      graph: side,
      capability: e.capability,
      anchor: e.anchor!,
    });
  }
  return withVerdict(delta);
}

/**
 * What a design would add, change or remove, in the slot a review fills with
 * the delta its code graph derived.
 *
 * The difference is the whole point of the kind and it is enforced here: a
 * review's entry is PROVEN - the anchor must sit on lines the pinned diff
 * really moved - while a design's entry is PROPOSED, and there is no diff to
 * prove it against. What stays true is the anchor: it is the SITE, real code at
 * the pinned commit that the proposal changes, replaces or plugs into, so a
 * proposal is always attached to something the reader can open. An anchor never
 * points at code that does not exist yet; nothing in thurview does.
 */
function compileProposals(ctx: {
  declared: Data["interfaces"];
  anchors: Record<string, CompiledAnchor>;
  used: Set<string>;
  err: (file: string, message: string) => void;
}): InterfaceDelta {
  const entries: InterfaceDelta["entries"] = [];
  for (const [key, e] of Object.entries(ctx.declared)) {
    // a symbol entry is refused earlier, with the reason a design cannot carry one
    if (e.symbol) continue;
    const anchor = ctx.anchors[e.anchor!];
    ctx.used.add(e.anchor!);
    if (!anchor) {
      ctx.err("data.yaml", `proposal ${key}: unknown anchor "${e.anchor}"`);
      continue;
    }
    if (!anchor.peek) {
      ctx.err(
        "data.yaml",
        `proposal ${key}: anchor "${e.anchor}" has no peek, so it names no site in the code as it stands`,
      );
      continue;
    }
    entries.push({
      id: `proposed:${key}`,
      change: e.change!,
      name: e.name!,
      was: "",
      kind: "proposed",
      file: anchor.peek.file,
      line: anchor.peek.from,
      graph: "head",
      capability: e.capability,
      anchor: e.anchor!,
    });
  }
  sortEntries(entries);
  const counts = (["removed", "changed", "added"] as const)
    .map((c) => [c, entries.filter((x) => x.change === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${c}`);
  return {
    entries,
    internal: 0,
    unreadable: [],
    // "Proposed" up front, because the same panel on a review states what a
    // change already did, and the two must never read the same.
    verdict: counts.length ? `Proposed: ${counts.join(", ")}.` : "Nothing proposed.",
    truncated: { base: false, head: false },
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
  // Left unclaimed, this fence is prose: markdown-it renders it as a code
  // block and the reader gets the diagram's source text with nothing saying
  // so. thurview draws only what it can anchor, so it says that here.
  if (FOREIGN_DIAGRAM_FENCES.has(b.component!)) {
    err(
      "review.md",
      `${b.component} is not rendered: thurview draws only what it can anchor at the pinned commit, so a user flow is the \`flow\` component and a message exchange is \`sequence\`. To quote ${b.component} source as code rather than draw it, fence it as \`text\``,
      b.line,
    );
    return null;
  }
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
  if (b.component === "flow") {
    const r = parseWith(FlowSchema, b.data);
    if (!r.ok) {
      for (const m of r.errors) err("review.md", `${where}: ${m}`, b.line);
      return null;
    }
    const ids = new Set<string>();
    for (const s of r.value.steps) {
      if (ids.has(s.id)) err("review.md", `${where}: duplicate step "${s.id}"`, b.line);
      ids.add(s.id);
    }
    const steps = r.value.steps.map((s) => {
      if (s.anchor) needPeek(s.anchor, `step ${s.id}`);
      if (s.actor && !ctx.data.actors[s.actor])
        err("review.md", `${where}: step ${s.id} references unknown actor "${s.actor}"`, b.line);
      return {
        id: s.id,
        label: s.label,
        ...(s.actor ? { actor: s.actor } : {}),
        ...(s.anchor ? { anchor: s.anchor } : {}),
        decision: !!s.when,
      };
    });
    // A flow of people alone is the picture this component exists to stop: the
    // reader can open none of it, and the anchored diagrams beside it lose by
    // association. One anchored step is the floor, as it is for an explainer.
    if (!r.value.steps.some((s) => s.anchor))
      err(
        "review.md",
        `${where}: no step carries an anchor, so nothing in this flow opens code`,
        b.line,
      );
    const edges: { from: string; to: string; case?: string }[] = [];
    for (const s of r.value.steps) {
      const targets = s.when ?? (s.next ? [{ to: s.next }] : []);
      const branched = new Set<string>();
      for (const t of targets) {
        if (t.to === s.id) {
          err("review.md", `${where}: step "${s.id}" follows itself`, b.line);
        } else if (!ids.has(t.to)) {
          err("review.md", `${where}: step "${s.id}" continues to unknown step "${t.to}"`, b.line);
        } else if (branched.has(t.to)) {
          // Two cases to one step are two arrows on one line with their labels
          // stacked on each other. One case naming both reads; this does not.
          err(
            "review.md",
            `${where}: step "${s.id}" branches to "${t.to}" twice; give the destination one case naming both`,
            b.line,
          );
        } else {
          branched.add(t.to);
          edges.push({ from: s.id, to: t.to, ...("case" in t ? { case: t.case } : {}) });
        }
      }
    }
    // The first step is the entry, and the layout walks forward from it. A step
    // nothing reaches would be drawn floating beside the flow, which is drawing
    // it wrong rather than refusing it.
    const entry = r.value.steps[0]!.id;
    const reached = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges)
        if (e.from === cur && !reached.has(e.to)) {
          reached.add(e.to);
          queue.push(e.to);
        }
    }
    for (const s of r.value.steps)
      if (!reached.has(s.id))
        err(
          "review.md",
          `${where}: step "${s.id}" is unreachable from "${entry}", the first step`,
          b.line,
        );
    return { id: b.id, line: b.line, type: "flow", label: r.value.label, steps, edges };
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
  kind?: DocumentKind;
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
  if (input.kind === "explainer" && m.base)
    err("an explainer has one pinned commit, so there is no base structure to compare against");
  // On a design the two halves of the map mean different things: `base` is the
  // structure as it stands, so a glob matching nothing there is a wrong claim
  // about today, while `nodes` is the structure the design proposes, and a part
  // it would create owns no file yet. Warning about that would be noise the
  // author cannot fix except by deleting the proposal.
  const proposedHead = input.kind === "design";
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
        if (proposedHead && graph === "head") continue;
        const re = globToRegExp(glob);
        // A design has one commit, so naming a "base commit" here would send the
        // author looking for the very thing `graph: base` is refused for.
        const at = proposedHead ? "the pinned commit" : `the pinned ${graph} commit`;
        if (!files.some((f) => re.test(f)))
          warn(`${graph}: node "${n.id}": no file matches "${glob}" at ${at}`);
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
