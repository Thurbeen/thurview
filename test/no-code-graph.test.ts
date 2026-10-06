import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

// Callers, tests and importers are found by the agent's own search, so nothing
// thurview ships may still send the agent, or promise the reader, a code graph.
describe("no code graph", () => {
  it("leaves no instruction or claim about one in the skills, the docs or the source", async () => {
    const shipped = [
      "README.md",
      "CONTRIBUTING.md",
      ...(await files("skills")),
      ...(await files("src")),
    ];
    const stale: string[] = [];
    for (const f of shipped) {
      // prose wraps, and comment markers sit between the words of a wrapped phrase
      const text = (await readFile(join(ROOT, f), "utf8")).replace(/[\s*/#>]+/g, " ");
      for (const m of text.matchAll(/thurview graph\b|code graph|tree.sitter|graphology/gi))
        stale.push(`${f}: ${text.slice(Math.max(0, m.index - 40), m.index + 40)}`);
    }
    expect(stale).toEqual([]);
  });

  it("depends on no parser or graph library", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /tree-sitter|graphology/.test(d))).toEqual([]);
  });
});
