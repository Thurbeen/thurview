import MarkdownIt from "markdown-it";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

export const COMPONENT_FENCES = new Set(["peek", "sequence", "callstack", "database"]);

export interface RawBlock {
  id: string;
  /** 1-based source line range */
  line: number;
  kind: "html" | "heading" | "component";
  html?: string;
  text?: string;
  level?: number;
  collapsed?: boolean;
  component?: string;
  /** parsed YAML for component fences (peek: the anchor id as { anchor }) */
  data?: unknown;
  yamlError?: string;
}

export interface ParsedDocument {
  title: string;
  frontmatter: Record<string, unknown>;
  blocks: RawBlock[];
  /** anchor ids referenced by anchor links, with source lines */
  anchorLinks: { id: string; line: number }[];
}

function md() {
  const m = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const defaultLink =
    m.renderer.rules["link_open"] ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  m.renderer.rules["link_open"] = (tokens, idx, options, env, self) => {
    const tok = tokens[idx]!;
    const href = String(tok.attrGet("href") ?? "");
    const mm = /^anchor:([\w-]+)$/.exec(href);
    if (mm) {
      tok.attrSet("href", `#anchor:${mm[1]}`);
      tok.attrSet("data-anchor", mm[1]!);
      tok.attrSet("class", "anchor-link");
    } else if (/^https?:/.test(href)) {
      tok.attrSet("target", "_blank");
      tok.attrSet("rel", "noreferrer");
    }
    return defaultLink(tokens, idx, options, env, self);
  };
  return m;
}

function splitFrontmatter(src: string): {
  fm: Record<string, unknown>;
  body: string;
  offset: number;
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { fm: {}, body: src, offset: 0 };
  let fm: Record<string, unknown> = {};
  try {
    const v = parseYaml(m[1]!);
    if (v && typeof v === "object") fm = v as Record<string, unknown>;
  } catch {
    /* ignored: reported as a plain document */
  }
  return { fm, body: src.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

function blockId(text: string, seen: Map<string, number>): string {
  const h = createHash("sha1").update(text.trim()).digest("hex").slice(0, 10);
  const n = seen.get(h) ?? 0;
  seen.set(h, n + 1);
  return n === 0 ? h : `${h}-${n}`;
}

export function parseDocument(src: string): ParsedDocument {
  const { fm, body, offset } = splitFrontmatter(src);
  const m = md();
  const env = {};
  const tokens = m.parse(body, env);
  const lines = body.split("\n");
  const blocks: RawBlock[] = [];
  const anchorLinks: { id: string; line: number }[] = [];
  const seen = new Map<string, number>();
  let title = typeof fm["title"] === "string" ? (fm["title"] as string) : "";

  const groups: Token[][] = [];
  let depth = 0;
  let cur: Token[] = [];
  for (const t of tokens) {
    cur.push(t);
    depth += t.nesting;
    if (depth === 0) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  for (const g of groups) {
    const first = g[0]!;
    const map = first.map ?? [0, 0];
    const srcText = lines.slice(map[0], map[1]).join("\n");
    const line = map[0] + 1 + offset;
    for (const t of g) {
      if (t.type === "inline" && t.children) {
        for (const c of t.children) {
          if (c.type === "link_open") {
            const mm = /^anchor:([\w-]+)$/.exec(String(c.attrGet("href") ?? ""));
            if (mm) anchorLinks.push({ id: mm[1]!, line });
          }
        }
      }
    }
    if (first.type === "fence" && COMPONENT_FENCES.has(first.info.trim().split(/\s+/)[0] ?? "")) {
      const component = first.info.trim().split(/\s+/)[0]!;
      const block: RawBlock = { id: blockId(srcText, seen), line, kind: "component", component };
      const content = first.content.trim();
      try {
        if (component === "peek") {
          block.data = /^[\w-]+$/.test(content) ? { anchor: content } : parseYaml(content);
        } else {
          block.data = parseYaml(content);
        }
      } catch (e) {
        block.yamlError = (e as Error).message;
      }
      blocks.push(block);
      continue;
    }
    if (first.type === "heading_open") {
      const inline = g[1]!;
      let text = inline.content;
      let collapsed = false;
      const mm = /\s*\{collapsed\}\s*$/.exec(text);
      if (mm) {
        collapsed = true;
        text = text.slice(0, mm.index);
        inline.content = text;
        if (inline.children) {
          const last = inline.children.filter((c) => c.type === "text").pop();
          if (last) last.content = last.content.replace(/\s*\{collapsed\}\s*$/, "");
        }
      }
      const level = Number(first.tag.slice(1));
      if (level === 1 && !title) title = text.trim();
      const html = m.renderer.render(g, m.options, env);
      blocks.push({
        id: blockId(srcText, seen),
        line,
        kind: "heading",
        level,
        text: text.trim(),
        collapsed,
        html,
      });
      continue;
    }
    const html = m.renderer.render(g, m.options, env);
    blocks.push({ id: blockId(srcText, seen), line, kind: "html", html });
  }
  return { title, frontmatter: fm, blocks, anchorLinks };
}
