// thurview has one theme: light, legible and printable. Nothing follows the
// reader's colour scheme or the reviewed project's look, and every text colour
// holds WCAG AA against the ground it sits on.
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { theme as code } from "../src/highlight-theme.js";

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
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

async function uiSources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const e of await readdir(join(ROOT, "src"), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(css|ts|html)$/.test(e.name)) continue;
    const path = join(e.parentPath, e.name);
    out.push({ path, text: await readFile(path, "utf8") });
  }
  return out;
}

async function tokens(): Promise<Record<string, string>> {
  const css = await readFile(join(ROOT, "src/ui/app.css"), "utf8");
  const root = /:root\s*{([^}]*)}/.exec(css)![1]!;
  return Object.fromEntries(
    [...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

describe("one theme", () => {
  it("depends on no colour-scheme preference and has no second palette", async () => {
    for (const { path, text } of await uiSources()) {
      expect(text, path).not.toMatch(/prefers-color-scheme/);
      expect(text, path).not.toMatch(/data-theme|theme-toggle/);
    }
    const css = await readFile(join(ROOT, "src/ui/app.css"), "utf8");
    expect(css.match(/:root\s*{/g)).toHaveLength(1);
    expect(css).toMatch(/color-scheme:\s*light;/);
  });

  it("holds WCAG AA for every text colour on every ground", async () => {
    const t = await tokens();
    const grounds = ["--bg", "--bg2", "--bg-code"];
    const text = ["--fg", "--fg2", "--muted", "--accent", "--ok", "--warn", "--del"];
    for (const g of grounds)
      for (const f of text)
        expect(contrast(t[f]!, t[g]!), `${f} on ${g}`).toBeGreaterThanOrEqual(4.5);
  });

  it("highlights code in the same light palette, each token at WCAG AA", async () => {
    const t = await tokens();
    expect(code.type).toBe("light");
    const bg = code.colors!["editor.background"]!;
    expect(bg.toLowerCase()).toBe(t["--bg-code"]!.toLowerCase());
    const fgs = [
      code.colors!["editor.foreground"]!,
      ...(code.tokenColors ?? []).flatMap((r) =>
        r.settings.foreground ? [r.settings.foreground] : [],
      ),
    ];
    for (const f of fgs) expect(contrast(f, bg), f).toBeGreaterThanOrEqual(4.5);
  });
});
