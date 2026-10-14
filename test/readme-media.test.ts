import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string) => readFile(join(ROOT, file), "utf8");

describe("README media", () => {
  it("opens on the demo and draws the process as an SVG, not Mermaid", async () => {
    const readme = await read("README.md");
    expect(readme).not.toContain("```mermaid");
    const demo = readme.indexOf("](./media/thurview-demo.gif)");
    const diagram = readme.indexOf("](./media/process.svg)");
    expect(demo).toBeGreaterThan(0);
    expect(diagram).toBeGreaterThan(demo);
    expect(readme).toMatch(/!\[[^\]]{40,}\]\(\.\/media\/process\.svg\)/);
  });

  it("keeps the process SVG self-contained, readable in both themes and still when asked", async () => {
    const svg = await read("media/process.svg");
    expect(svg).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby="title desc"/);
    expect(svg).toMatch(/<title id="title">[^<]+<\/title>/);
    expect(svg).toMatch(/<desc id="desc">[^<]+<\/desc>/);
    expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {4}\}/.exec(svg)?.[1];
    expect(reduced).toMatch(/\.motion \{[^}]*animation: none/);
    expect(reduced).toMatch(/\.token \{[^}]*animation: none/);
    expect(svg).not.toMatch(/<script|<foreignObject|(?:href|src)=["']https?:\/\//);
  });
});
