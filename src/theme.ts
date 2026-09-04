import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ThemeRegistration } from "shiki";
import type { Diagnostic } from "./document/compile.js";

const color = z.string().min(1).max(64);

export const ThemeSchema = z
  .object({
    name: z.string().min(1),
    /** where the tokens came from: files inspected in the project, or "default" */
    source: z.string().optional(),
    mode: z.enum(["dark", "light"]).default("dark"),
    colors: z
      .object({
        bg: color.optional(),
        bg2: color.optional(),
        bg3: color.optional(),
        code: color.optional(),
        fg: color.optional(),
        fg2: color.optional(),
        muted: color.optional(),
        line: color.optional(),
        accent: color.optional(),
        link: color.optional(),
        ok: color.optional(),
        warn: color.optional(),
        del: color.optional(),
        add: color.optional(),
        remove: color.optional(),
        select: color.optional(),
      })
      .strict()
      .prefault({}),
    fonts: z
      .object({
        display: z.string().optional(),
        body: z.string().optional(),
        mono: z.string().optional(),
        /** external stylesheets, e.g. Google Fonts css2 urls */
        stylesheets: z.array(z.string().url()).default([]),
        /** font files inside the reviewed repository at the head commit */
        files: z
          .array(
            z
              .object({
                family: z.string().min(1),
                path: z.string().min(1),
                weight: z.string().optional(),
                style: z.string().optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .prefault({}),
    shape: z
      .object({
        radius: z.string().optional(),
        bevel: z.boolean().optional(),
        glow: z.boolean().optional(),
        scanlines: z.boolean().optional(),
        /** text-transform for display headings, e.g. none or uppercase */
        headingTransform: z.string().optional(),
      })
      .strict()
      .prefault({}),
    code: z
      .object({
        keyword: color.optional(),
        string: color.optional(),
        function: color.optional(),
        type: color.optional(),
        variable: color.optional(),
        number: color.optional(),
        comment: color.optional(),
        punctuation: color.optional(),
        operator: color.optional(),
        tag: color.optional(),
        fg: color.optional(),
      })
      .strict()
      .prefault({}),
    /** extra rules appended verbatim */
    css: z.string().optional(),
  })
  .strict();

export type Theme = z.infer<typeof ThemeSchema>;

export interface CompiledTheme {
  name: string;
  source?: string;
  /** stylesheet applied on top of the default skin */
  css: string;
  /** shiki theme registration for this palette */
  shiki: ThemeRegistration;
}

export function parseTheme(yaml: string): { theme: Theme | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    diagnostics.push({
      level: "error",
      file: "theme.yaml",
      message: `YAML: ${(e as Error).message}`,
    });
    return { theme: null, diagnostics };
  }
  if (raw === null || raw === undefined) return { theme: null, diagnostics };
  const r = ThemeSchema.safeParse(raw);
  if (!r.success) {
    for (const i of r.error.issues)
      diagnostics.push({
        level: "error",
        file: "theme.yaml",
        message: `${i.path.join(".") || "root"}: ${i.message}`,
      });
    return { theme: null, diagnostics };
  }
  return { theme: r.data, diagnostics };
}

const DEFAULT_CODE = {
  fg: "#e0e0e0",
  keyword: "#ff8c8c",
  string: "#6eff6e",
  function: "#ffb627",
  type: "#ffb627",
  variable: "#00d9ff",
  number: "#ffb627",
  comment: "#948a7d",
  punctuation: "#948a7d",
  operator: "#ff5c54",
  tag: "#ff5c54",
};

export function shikiTheme(
  name: string,
  code: Partial<typeof DEFAULT_CODE>,
  mode: "dark" | "light",
  bg = "#0d0b09",
): ThemeRegistration {
  const c = { ...DEFAULT_CODE, ...code };
  return {
    name,
    type: mode,
    colors: { "editor.background": bg, "editor.foreground": c.fg },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: c.comment, fontStyle: "italic" },
      },
      {
        scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
        settings: { foreground: c.punctuation },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "constant.language",
          "variable.language",
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ["keyword.operator", "keyword.operator.assignment", "keyword.operator.arrow"],
        settings: { foreground: c.operator },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "punctuation.definition.string",
          "markup.inserted",
        ],
        settings: { foreground: c.string },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
        ],
        settings: { foreground: c.function },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "support.class",
          "support.type",
          "entity.other.inherited-class",
          "entity.name.namespace",
        ],
        settings: { foreground: c.type },
      },
      {
        scope: [
          "constant.numeric",
          "constant.character",
          "constant.other",
          "constant.language.boolean",
        ],
        settings: { foreground: c.number },
      },
      {
        scope: [
          "entity.name.tag",
          "support.type.property-name",
          "meta.object-literal.key",
          "entity.other.attribute-name",
          "meta.property-name",
        ],
        settings: { foreground: c.tag },
      },
      {
        scope: [
          "variable",
          "variable.parameter",
          "variable.other",
          "meta.definition.variable",
          "entity.name.variable",
        ],
        settings: { foreground: c.variable },
      },
      { scope: ["markup.deleted"], settings: { foreground: c.operator } },
      {
        scope: ["markup.heading", "entity.name.section"],
        settings: { foreground: c.tag, fontStyle: "bold" },
      },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    ],
  };
}

/** Build the stylesheet and highlighter theme for a review. `blobUrl` maps a repo path to a served url. */
export function compileTheme(theme: Theme, blobUrl: (path: string) => string): CompiledTheme {
  const hash = createHash("sha1").update(JSON.stringify(theme)).digest("hex").slice(0, 8);
  const name = `theme-${hash}`;
  const v: string[] = [];
  const c = theme.colors;
  const map: Record<string, string | undefined> = {
    "--bg": c.bg,
    "--bg2": c.bg2,
    "--bg3": c.bg3,
    "--bg-code": c.code,
    "--hud-bg": c.bg2,
    "--hud-deep": c.bg,
    "--fg": c.fg,
    "--fg2": c.fg2,
    "--muted": c.muted,
    "--line": c.line,
    "--line2": c.line,
    "--hud-edge": c.line,
    "--accent": c.accent,
    "--doom": c.accent,
    "--doom-bright": c.accent,
    "--ember": c.accent,
    "--red": c.del ?? c.accent,
    "--green": c.link ?? c.ok,
    "--ok": c.ok,
    "--yellow": c.warn,
    "--warn": c.warn,
    "--del": c.del,
    "--blue": c.link,
    "--font-display": theme.fonts.display,
    "--font-body": theme.fonts.body,
    "--font-mono": theme.fonts.mono,
    "--radius": theme.shape.radius,
    "--heading-transform": theme.shape.headingTransform,
  };
  for (const [k, val] of Object.entries(map)) if (val) v.push(`${k}: ${val};`);
  if (c.add) v.push(`--add-bg: ${c.add};`);
  if (c.remove) v.push(`--del-bg: ${c.remove};`);
  if (c.select) v.push(`--sel: ${c.select};`);
  if (c.accent) v.push(`--accent-bg: color-mix(in srgb, ${c.accent} 16%, transparent);`);
  if (theme.mode === "light") v.push("color-scheme: light;");
  if (theme.shape.glow === false) v.push("--glow-red: none; --glow-green: none;");
  else if (c.accent)
    v.push(
      `--glow-red: 0 0 5px color-mix(in srgb, ${c.accent} 70%, transparent), 0 0 12px color-mix(in srgb, ${c.accent} 40%, transparent);`,
    );
  if (theme.shape.bevel === false)
    v.push("--bevel: none; --bevel-glow-red: 0 0 0 1px var(--accent);");
  const out: string[] = [];
  for (const s of theme.fonts.stylesheets) out.push(`@import url("${s}");`);
  for (const f of theme.fonts.files) {
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    const fmt =
      ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : ext === "otf" ? "opentype" : "truetype";
    out.push(
      `@font-face { font-family: "${f.family}"; src: url("${blobUrl(f.path)}") format("${fmt}"); font-weight: ${f.weight ?? "400"}; font-style: ${f.style ?? "normal"}; font-display: swap; }`,
    );
  }
  out.push(`:root { ${v.join(" ")} }`);
  if (theme.shape.scanlines === false) out.push("body::after { display: none; }");
  if (theme.mode === "light")
    out.push("body { background-image: none; } .code span[style] { filter: none; }");
  if (theme.css) out.push(theme.css);
  return {
    name: theme.name,
    ...(theme.source ? { source: theme.source } : {}),
    css: out.join("\n"),
    shiki: shikiTheme(
      name,
      theme.code,
      theme.mode,
      c.code ?? (theme.mode === "light" ? "#ffffff" : "#0d0b09"),
    ),
  };
}
