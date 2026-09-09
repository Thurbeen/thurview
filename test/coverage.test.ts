import { describe, it, expect } from "vitest";
import { computeCoverage, scopeTruncated } from "../src/coverage.ts";
import type { CodeGraph } from "../src/graph.ts";

function graph(overrides: Partial<CodeGraph> = {}): CodeGraph {
  return {
    commit: "deadbeef",
    files: [],
    symbols: [],
    edges: [],
    unresolved: 0,
    unresolvedByFile: {},
    truncated: false,
    ...overrides,
  };
}

describe("computeCoverage", () => {
  it("tells a graph-language file the repo-wide cap dropped apart from one the graph cannot read", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "**",
      allFiles: ["src/seen.ts", "src/dropped.ts", "notes.md"],
      graph: graph({ files: ["src/seen.ts"] }),
      anchored: [],
      owners: [],
    });
    expect(cov.files.capped).toBe(1);
    expect(cov.truncated).toBe(true);
    expect(cov.unclustered).toContainEqual(
      expect.objectContaining({ file: "src/dropped.ts", reason: "capped" }),
    );
    expect(cov.unclustered).toContainEqual(
      expect.objectContaining({ file: "notes.md", reason: "outsideGraph" }),
    );
    expect(cov.files.outsideGraph).toBe(1);
  });

  it("sums unresolved references only from files inside the requested scope", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "src/in",
      allFiles: ["src/in/a.ts", "src/out/b.ts"],
      graph: graph({
        files: ["src/in/a.ts", "src/out/b.ts"],
        unresolved: 5,
        unresolvedByFile: { "src/in/a.ts": 2, "src/out/b.ts": 3 },
      }),
      anchored: [],
      owners: [],
    });
    expect(cov.unresolved).toBe(2);
  });
});

describe("scopeTruncated", () => {
  it("is false when the whole-repo graph is truncated but nothing inside the scope was dropped", () => {
    const truncated = scopeTruncated(
      ["src/in/a.ts", "src/out/dropped.ts"],
      graph({ files: ["src/in/a.ts"], truncated: true }),
      "src/in",
    );
    expect(truncated).toBe(false);
  });

  it("is true when a graph-language file inside the scope is missing from the graph", () => {
    const truncated = scopeTruncated(
      ["src/in/a.ts", "src/in/dropped.ts"],
      graph({ files: ["src/in/a.ts"] }),
      "src/in",
    );
    expect(truncated).toBe(true);
  });
});
