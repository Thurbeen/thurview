import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, graphAt, impact, architecture, capFiles, GRAPH_SCHEMA } from "../src/graph.ts";
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

describe("graphAt", () => {
  it("rebuilds a graph cached by an older binary instead of trusting its shape", async () => {
    const { dir, git } = await repo();
    await writeFile(
      join(dir, "src", "a.ts"),
      `export function run() {\n  return fetch("/x");\n}\n`,
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const commit = (await git("rev-parse", "HEAD")).stdout.trim();
    // what a pre-upgrade thurview left on disk: right commit, missing fields
    const cache = join(dir, ".cache", "graph", `${commit}.json`);
    await mkdir(join(dir, ".cache", "graph"), { recursive: true });
    await writeFile(
      cache,
      JSON.stringify({
        commit,
        files: [],
        symbols: [],
        edges: [],
        unresolved: 0,
        truncated: false,
      }),
    );
    const g = await graphAt(dir, commit, join(dir, ".cache"));
    // trusting the stale record would report zero unresolved references, which is
    // a wrong number rather than an error
    expect(g.schema).toBe(GRAPH_SCHEMA);
    expect(g.unresolvedByFile).toEqual({ "src/a.ts": 1 });
    const again = await graphAt(dir, commit, join(dir, ".cache"));
    expect(again.unresolvedByFile).toEqual({ "src/a.ts": 1 });
  });
});

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
    expect(g.unresolvedByFile).toEqual({ "src/a.ts": 1 });
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

  it("gives each caller the change left alone its call site and whether a test reaches it", async () => {
    const { dir, git } = await repo();
    await mkdir(join(dir, "test"));
    const caller = (fn: string, arg: string) =>
      `import { discount } from "./price";\n\nexport function ${fn}(total: number) {\n  return discount(total, ${arg});\n}\n`;
    await writeFile(
      join(dir, "src", "price.ts"),
      `export function discount(total: number, percent: number) {\n  return total - (total * percent) / 100;\n}\n`,
    );
    await writeFile(join(dir, "src", "cart.ts"), caller("checkout", "15"));
    await writeFile(join(dir, "src", "invoice.ts"), caller("invoice", "5"));
    await writeFile(
      join(dir, "test", "invoice.test.ts"),
      `import { invoice } from "../src/invoice";\n\nexport function invoicesFive() {\n  return invoice(100) === 95;\n}\n`,
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    // discount takes a rate now, and neither caller outside the diff was told
    await writeFile(
      join(dir, "src", "price.ts"),
      `export function discount(total: number, rate: number) {\n  return total - total * rate;\n}\n`,
    );
    await git("commit", "-q", "-am", "take a rate");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const result = impact(
      await buildGraph(dir, base),
      await buildGraph(dir, head),
      await lineChanges(dir, base, head),
      2,
    );
    const via = "src/price.ts:discount";
    expect([...result.reach].sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: "checkout", file: "src/cart.ts", line: 3, depth: 1, via, at: 4, tested: false },
      { symbol: "invoice", file: "src/invoice.ts", line: 3, depth: 1, via, at: 4, tested: true },
    ]);
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
