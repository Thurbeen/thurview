import { describe, expect, it } from "vitest";
import { compileTheme, parseTheme } from "../src/theme.js";

const compile = (yaml: string) => {
  const { theme, diagnostics } = parseTheme(yaml);
  expect(diagnostics).toEqual([]);
  return compileTheme(theme!, (p) => `/blob/${p}`).css;
};

describe("theme", () => {
  it("keeps the retro extras off unless a theme opts in", () => {
    const css = compile("name: plain\ncolors: { accent: '#2563eb' }\n");
    expect(css).not.toMatch(/--glow|--shadow|body::after/);
    const retro = compile("name: retro\nshape: { bevel: true, glow: true, scanlines: true }\n");
    expect(retro).toContain("--glow: 0 0 5px");
    expect(retro).toContain("--shadow: 0 0 0 1px");
    expect(retro).toContain("body::after");
  });
  it("maps semantic colors onto the skin's tokens", () => {
    const css = compile(
      "name: acme\nmode: light\ncolors: { accent: '#2563eb', link: '#1d4ed8', ok: '#16a34a', warn: '#d97706', del: '#dc2626' }\n",
    );
    for (const t of [
      "--accent: #2563eb",
      "--link: #1d4ed8",
      "--ok: #16a34a",
      "--warn: #d97706",
      "--del: #dc2626",
      "color-scheme: light",
    ])
      expect(css).toContain(t);
  });
});
