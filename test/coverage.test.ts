import { describe, it, expect } from "vitest";
import { computeCoverage, type SearchRecord } from "../src/coverage.ts";

const search = (key: string, files: string[], hits = files.length): SearchRecord => ({
  key,
  pattern: key,
  paths: [],
  hits,
  files,
});

describe("computeCoverage", () => {
  it("counts a file only a recorded search matched as searched, below anchored and placed", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "**",
      allFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      anchored: ["src/a.ts"],
      owners: [{ node: "b", globs: ["src/b.ts"] }],
      searches: [search("callers", ["src/a.ts", "src/b.ts", "src/c.ts"])],
    });
    expect(cov.states).toEqual({ explained: 1, placed: 1, searched: 1, uncovered: 1 });
    expect(cov.uncovered).toEqual(["src/d.ts"]);
    expect(cov.verdict).toBe(
      "4 files at deadbeef in the repository, 1 anchored in the document, 1 placed on the map only, 1 matched by a recorded search only, 1 not examined.",
    );
  });

  it("states a search that matched nothing, since a zero is a finding", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "**",
      allFiles: ["src/a.ts"],
      anchored: ["src/a.ts"],
      owners: [],
      searches: [search("tests", [], 0)],
    });
    expect(cov.searches).toEqual([expect.objectContaining({ key: "tests", hits: 0, files: [] })]);
  });

  it("does not count a search hit outside the scope", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "src/in",
      allFiles: ["src/in/a.ts", "src/out/b.ts"],
      anchored: [],
      owners: [],
      searches: [search("callers", ["src/out/b.ts"])],
    });
    expect(cov.files.total).toBe(1);
    expect(cov.states).toEqual({ explained: 0, placed: 0, searched: 0, uncovered: 1 });
  });

  it("groups the files in scope by the directory under it, largest first", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "**",
      allFiles: ["README.md", "src/a.ts", "src/b.ts", "test/a.test.ts"],
      anchored: ["src/a.ts"],
      owners: [],
      searches: [],
    });
    expect(cov.clusters.map((c) => [c.label, c.files])).toEqual([
      ["src", 2],
      [".", 1],
      ["test", 1],
    ]);
    expect(cov.clusters[0]).toEqual(
      expect.objectContaining({ explained: ["src/a.ts"], uncovered: ["src/b.ts"] }),
    );
  });

  it("keeps the files at the top of a scope apart from a directory of the same name", () => {
    const cov = computeCoverage({
      commit: "deadbeef",
      scope: "src",
      allFiles: ["src/x.ts", "src/src/y.ts"],
      anchored: [],
      owners: [],
      searches: [],
    });
    expect(cov.clusters.map((c) => c.label).sort()).toEqual(["src", "src/"]);
  });
});
