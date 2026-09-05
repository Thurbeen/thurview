import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, impact, architecture, capFiles } from "../src/graph.ts";
import { lineChanges } from "../src/git.ts";

const execFileP = promisify(execFile);

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "thurview-graph-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (...a: string[]) => execFileP("git", a, { cwd: dir, env });
  await git("init", "-q", "-b", "main");
  await mkdir(join(dir, "src"));
  return { dir, git };
}

describe("buildGraph", () => {
  it("counts a call to an undefined name as unresolved instead of dropping it", async () => {
    const { dir, git } = await repo();
    await writeFile(
      join(dir, "src", "a.ts"),
      `export function run() {\n  return fetch("/x");\n}\n`,
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const g = await buildGraph(dir, head);
    expect(g.unresolved).toBe(1);
    expect(g.edges).toEqual([]);
  });

  it("does not resolve a call to a nested non-method definition in another file", async () => {
    const { dir, git } = await repo();
    await writeFile(
      join(dir, "src", "a.ts"),
      `export function outer() {\n  const helper = () => 1;\n  return helper();\n}\n`,
    );
    await writeFile(join(dir, "src", "b.ts"), `export function run() {\n  return helper();\n}\n`);
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const g = await buildGraph(dir, head);
    const falseEdge = g.edges.find(
      (e) => e.from.startsWith("src/b.ts:") && e.to.includes("helper"),
    );
    expect(falseEdge).toBeUndefined();
    expect(g.unresolved).toBeGreaterThanOrEqual(1);
  });
});

describe("capFiles", () => {
  it("passes small lists through untruncated", () => {
    const { files, truncated } = capFiles(["a.ts", "b.ts"]);
    expect(truncated).toBe(false);
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  it("caps lists over the limit and reports truncation", () => {
    const many = Array.from({ length: 4001 }, (_, i) => `f${i}.ts`);
    const { files, truncated } = capFiles(many);
    expect(truncated).toBe(true);
    expect(files).toHaveLength(4000);
  });
});

describe("impact", () => {
  it("does not misclassify an unchanged symbol in a renamed file as added or removed", async () => {
    const { dir, git } = await repo();
    await writeFile(
      join(dir, "src", "a.ts"),
      `export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 2;\n}\n`,
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("mv", "src/a.ts", "src/b.ts");
    await writeFile(
      join(dir, "src", "b.ts"),
      `export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 3;\n}\n`,
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "rename and tweak bar");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const baseGraph = await buildGraph(dir, base);
    const headGraph = await buildGraph(dir, head);
    const changes = await lineChanges(dir, base, head);
    const result = impact(baseGraph, headGraph, changes, 1);
    const byName = new Map(result.changed.map((c) => [c.symbol, c.change]));
    expect(byName.get("foo")).toBeUndefined();
    expect(byName.get("bar")).toBe("modified");
    expect(result.truncated).toEqual({ base: false, head: false });
  });
});

describe("architecture", () => {
  it("reports truncated as false for a normal-sized graph", async () => {
    const { dir, git } = await repo();
    await writeFile(join(dir, "src", "a.ts"), `export function foo() {\n  return 1;\n}\n`);
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const commit = (await git("rev-parse", "HEAD")).stdout.trim();
    const g = await buildGraph(dir, commit);
    const arch = architecture(g, g);
    expect(arch.truncated).toEqual({ base: false, head: false });
  });
});
