// thurview has two palettes, light and dark, and nothing else: no review
// restyles itself. The OS picks between them until the reader does, in one
// place - the boot script in index.html - and every text and code colour holds
// WCAG AA against every ground it sits on, in both.
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { highlightLines } from "../src/highlight.js";

const ROOT = join(import.meta.dirname, "..");

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** `rgb(r g b / a)` laid over an opaque `#rrggbb` ground, as the browser composites it. */
function over(tint: string, ground: string): string {
  const m = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(tint);
  if (!m) throw new Error(`not an rgb() tint: ${tint}`);
  const a = Number(m[4]);
  return (
    "#" +
    [1, 2, 3]
      .map((i) => {
        const g = parseInt(ground.slice(2 * i - 1, 2 * i + 1), 16);
        const v = Math.round(Number(m[i]) * a + g * (1 - a));
        return v.toString(16).padStart(2, "0");
      })
      .join("")
  );
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

async function sources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const e of await readdir(join(ROOT, "src"), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(css|ts|html)$/.test(e.name)) continue;
    const path = join(e.parentPath, e.name);
    out.push({ path, text: await readFile(path, "utf8") });
  }
  return out;
}

const css = () => readFile(join(ROOT, "src/ui/app.css"), "utf8");
function block(text: string, selector: string): Record<string, string> {
  const at = text.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = text.slice(at, text.indexOf("}", at));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}
async function palettes(): Promise<Record<"light" | "dark", Record<string, string>>> {
  const text = await css();
  const light = block(text, ":root");
  return { light, dark: { ...light, ...block(text, ':root[data-theme="dark"]') } };
}

const COLOURS = [
  "--bg",
  "--bg2",
  "--bg3",
  "--bg-code",
  "--fg",
  "--fg2",
  "--muted",
  "--line",
  "--line2",
  "--accent",
  "--ok",
  "--warn",
  "--del",
  "--on-fill",
  "--add-bg",
  "--del-bg",
  "--sel",
  "--accent-bg",
  "--shadow",
  "--shadow-lg",
];
const CODE = [
  "--code-fg",
  "--code-keyword",
  "--code-string",
  "--code-function",
  "--code-type",
  "--code-variable",
  "--code-number",
  "--code-comment",
  "--code-punctuation",
  "--code-tag",
];

describe("theme", () => {
  it("defines each palette once, and lets only the boot script read the OS preference", async () => {
    const text = await css();
    expect(text.match(/:root\s*{/g)).toHaveLength(1);
    expect(text.match(/:root\[data-theme="dark"\]\s*{/g)).toHaveLength(1);
    const dark = block(text, ':root[data-theme="dark"]');
    for (const t of [...COLOURS, ...CODE]) expect(dark[t], `dark ${t}`).toBeDefined();
    for (const { path, text: src } of await sources())
      if (!path.endsWith("index.html")) expect(src, path).not.toMatch(/prefers-color-scheme/);
  });

  for (const name of ["light", "dark"] as const) {
    it(`holds WCAG AA for every text colour on every ground (${name})`, async () => {
      const t = (await palettes())[name];
      for (const g of ["--bg", "--bg2", "--bg3", "--bg-code"])
        for (const f of ["--fg", "--fg2", "--muted", "--accent", "--ok", "--warn", "--del"])
          expect(contrast(t[f]!, t[g]!), `${f} on ${g}`).toBeGreaterThanOrEqual(4.5);
      for (const f of ["--accent", "--ok", "--del"])
        expect(contrast(t["--on-fill"]!, t[f]!), `--on-fill on ${f}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps every code colour at WCAG AA, on plain and tinted rows (${name})`, async () => {
      const t = (await palettes())[name];
      const bg = t["--bg-code"]!;
      const grounds = [bg, ...["--add-bg", "--del-bg", "--sel"].map((v) => over(t[v]!, bg))];
      for (const g of grounds)
        for (const f of CODE)
          expect(contrast(t[f]!, g), `${f} on ${g}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("highlights code with the palette's tokens, so a sealed excerpt follows the reader's palette", async () => {
    const [line] = await highlightLines("const a = 'x'; // note\n", "typescript");
    expect(line).toContain("var(--code-keyword)");
    expect(line).toContain("var(--code-string)");
    expect(line).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
