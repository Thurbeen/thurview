/** Rules are exercised through publish, sealed files, HTTP and HTML export. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeScope, allowsEverything, ScopeError, SCOPE_FILE } from "../src/scope.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const SECRET_MARKER = "AKIAIOSFODNN7EXAMPLE";
/** defined only in a module's test directory, which `*` + `/test` withholds */
const MODULE_TEST_SYMBOL = "moduleTestOnlySymbol";
/** defined in a `test` directory two levels down, which `*` does not reach */
const DEEP_TEST_SYMBOL = "deepTestIsKept";
/** defined in a `fixtures` directory at the root, which `**` reaches with zero segments */
const ROOT_FIXTURE_SYMBOL = "rootFixtureSymbol";

/**
 * The rules. `*` + `/tset` is the typo this feature makes possible: it reads
 * like a rule in force and holds nothing out, so publish has to say so.
 */
const RULES = [
  "extensions: [ts, md, woff2]",
  "exclude:",
  '  - "*/test"',
  '  - "**/fixtures"',
  '  - "*/tset"',
  "",
].join("\n");

let repo: string;
let home: string;
let server: { port: number; close(): Promise<void> };
let reviewId = "";
let reviewDir = "";
let headSha = "";

type Out = Record<string, any>;

async function cli(args: string[], opts: { expectCode?: number } = {}): Promise<Out> {
  const env = { ...process.env, THURVIEW_HOME: home };
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd: repo, env },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const want = opts.expectCode ?? 0;
      if (code !== want)
        return reject(
          new Error(`thurview ${args.join(" ")} exited ${code}, wanted ${want}\n${out}\n${err}`),
        );
      try {
        resolve(decode(out.trim()) as Out);
      } catch (e) {
        reject(new Error(`bad TOON: ${(e as Error).message}\n${out}`));
      }
    });
  });
}

const git = (...a: string[]) =>
  execFileP("git", a, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

async function get(path: string): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`);
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Report a non-JSON error without hiding its response body. */
  }
  return { status: r.status, text, json };
}

async function write(rel: string, body: string): Promise<void> {
  const full = join(repo, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
}

beforeAll(async () => {
  await mkdir(join(ROOT, "node_modules", ".cache"), { recursive: true });
  home = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-globs-home-"));
  repo = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-globs-repo-"));
  await git("init", "-q", "-b", "main");
  await write(SCOPE_FILE, RULES);
  await write("module-a/src/a.ts", `export function a(n: number) {\n  return n + 1;\n}\n`);
  await write("module-b/src/b.ts", `export function b(n: number) {\n  return n * 2;\n}\n`);
  // withheld by `*/test`, one per module - the lines nobody has to write now
  await write(
    "module-a/test/a.test.ts",
    `export function ${MODULE_TEST_SYMBOL}() {\n  return "${SECRET_MARKER}";\n}\n`,
  );
  await write("module-b/test/b.test.ts", `export const bTest = "${SECRET_MARKER}";\n`);
  // an allowed asset extension, withheld only by the glob
  await write("module-a/test/Probe.woff2", "not really a font\n");
  // `*` is one segment: a `test` two levels down stays in scope
  await write("a/b/test/deep.ts", `export function ${DEEP_TEST_SYMBOL}() {\n  return 1;\n}\n`);
  // and `test` is a whole segment, not a prefix of one
  await write("module-a/testing/t.ts", `export const testing = 1;\n`);
  // `**` is zero or more segments: the root `fixtures` and a nested one alike
  await write("fixtures/root.ts", `export function ${ROOT_FIXTURE_SYMBOL}() {\n  return 2;\n}\n`);
  await write("pkg/x/fixtures/f.ts", `export const f = "${SECRET_MARKER}";\n`);
  await git("add", ".");
  await git("commit", "-q", "-m", "base");

  await git("checkout", "-q", "-b", "feature");
  await write("module-a/src/a.ts", `export function a(n: number) {\n  return n + 2;\n}\n`);
  await write(
    "module-a/test/a.test.ts",
    `export function ${MODULE_TEST_SYMBOL}() {\n  return "${SECRET_MARKER}!";\n}\n`,
  );
  await write("a/b/test/deep.ts", `export function ${DEEP_TEST_SYMBOL}() {\n  return 3;\n}\n`);
  await write("pkg/x/fixtures/f.ts", `export const f = "${SECRET_MARKER}!";\n`);
  await git("add", ".");
  await git("commit", "-q", "-m", "step a by two");
  headSha = (await git("rev-parse", "HEAD")).stdout.trim();

  process.env["THURVIEW_HOME"] = home;
  const { startServer } = await import("../src/server/server.ts");
  server = await startServer({ hosts: ["127.0.0.1"] });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("the glob matcher", () => {
  const scope = makeScope({ extensions: ["ts"], exclude: ["*/test", "**/fixtures"] });

  it("reads `*` as exactly one segment, anchored at the first", () => {
    expect(scope.inScope("module-a/test/a.test.ts")).toBe(false);
    expect(scope.inScope("module-b/test/deep/b.test.ts")).toBe(false);
    // two segments before `test`: `*` does not cross a `/`
    expect(scope.inScope("a/b/test/deep.ts")).toBe(true);
    // zero segments before `test`: `*` is one, not zero or one
    expect(scope.inScope("test/root.ts")).toBe(true);
    // a whole segment, not a prefix of one
    expect(scope.inScope("module-a/testing/t.ts")).toBe(true);
    expect(scope.inScope("module-a/test.ts")).toBe(true);
  });

  it("reads `**` as zero or more segments, the root included", () => {
    expect(scope.inScope("fixtures/root.ts")).toBe(false);
    expect(scope.inScope("pkg/fixtures/f.ts")).toBe(false);
    expect(scope.inScope("pkg/x/y/fixtures/f.ts")).toBe(false);
    expect(scope.inScope("pkg/x/fixturesque/f.ts")).toBe(true);
  });

  it("takes `*` and `?` inside a segment, with every other character literal", () => {
    const s = makeScope({
      extensions: ["ts"],
      exclude: ["mod-*/gen", "v?/old", "a.b+(c)*/tmp", "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"],
    });
    expect(s.inScope("mod-a/gen/x.ts")).toBe(false);
    expect(s.inScope("mod-/gen/x.ts")).toBe(false);
    expect(s.inScope("lib/mod-a/gen/x.ts")).toBe(true);
    expect(s.inScope("v1/old/x.ts")).toBe(false);
    expect(s.inScope("v10/old/x.ts")).toBe(true);
    expect(s.inScope("a.b+(c)1/tmp/x.ts")).toBe(false);
    expect(s.inScope("aXb+(c)1/tmp/x.ts")).toBe(true);
    // A backtracking regex took seconds on this one path; the rules come from
    // the change under review, so matching has to stay linear in the segment.
    const started = Date.now();
    expect(s.inScope(`${"a".repeat(40)}/x.ts`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("refuses a bracket rather than read a route directory as a character class", () => {
    // `app/[id]` read as a class would be "one i or d" and leave the real
    // directory open; before globs it was an error, and it stays one
    for (const entry of ["app/[id]", "src/routes/[...rest]", "[ab]x/tmp", "mod]/test"])
      expect(() => makeScope({ extensions: ["ts"], exclude: [entry] }), entry).toThrow(
        /holds a bracket/,
      );
    const q = makeScope({ extensions: ["tsx"], exclude: ["app/?id?"] });
    expect(q.inScope("app/[id]/page.tsx")).toBe(false);
  });

  it("canonicalises the path the way git does before a glob sees it", () => {
    for (const p of ["./module-a/test/a.ts", "././module-a//test/a.ts", "/module-a/test/a.ts"])
      expect(scope.inScope(p), p).toBe(false);
  });

  it("refuses a glob it cannot read where it is written, rather than matching nothing", () => {
    const bad: [string, RegExp][] = [
      ["mod[a/test", /bracket/],
      ["***/test", /whole segments/],
      ["**test", /whole segments/],
      ["*//test", /empty segment/],
      ["**", /whole repository/],
      ["*", /whole repository/],
      ["*/**", /whole repository/],
      ["?*", /whole repository/],
      ["**/*?", /whole repository/],
      ["*/../x", /leaves the repository/],
    ];
    for (const [entry, why] of bad) {
      expect(() => makeScope({ extensions: ["ts"], exclude: [entry] }), entry).toThrow(ScopeError);
      expect(() => makeScope({ extensions: ["ts"], exclude: [entry] }), entry).toThrow(why);
    }
  });

  it("still refuses a glob under extensions and a path under filenames", () => {
    expect(() => makeScope({ extensions: ["*.ts"] })).toThrow(/bare suffix/);
    expect(() => makeScope({ extensions: ["tar.gz"] })).toThrow(/only the last suffix/);
    expect(() => makeScope({ filenames: ["src/Dockerfile"] })).toThrow(/whole file name/);
  });

  it("gives a glob its own digest, which keeps symbol caches separate", () => {
    const plain = makeScope({ extensions: ["ts"] });
    const star = makeScope({ extensions: ["ts"], exclude: ["*/test"] });
    const deep = makeScope({ extensions: ["ts"], exclude: ["**/test"] });
    expect(star.digest).not.toBe(plain.digest);
    expect(deep.digest).not.toBe(star.digest);
  });
});

describe("an exclude list without a glob behaves exactly as it did before globs", () => {
  /**
   * The verdicts below were produced by the matcher as it stood before globs
   * were read, over these rules and these paths, and pasted in unchanged. The
   * entries hold every character a directory name could already carry that is
   * not a glob one - a brace, a space, a trailing and a leading `./` - so a
   * change in what counts as a glob shows up here as a changed verdict.
   */
  const RULES_BEFORE = {
    extensions: ["ts", "md", "css"],
    filenames: ["Dockerfile", ".env"],
    exclude: [
      "secrets/",
      "./app/src/test",
      "src/generated",
      "pkg{a}",
      "a b/c",
      "Docs",
      "src/generated/",
    ],
  };
  const VERDICTS_BEFORE: Record<string, boolean> = {
    "src/app.ts": true,
    "secrets/a.ts": false,
    secrets: false,
    "secretsX/a.ts": true,
    "Secrets/a.ts": true,
    "x/secrets/a.ts": true,
    "././secrets/a.ts": false,
    "/secrets/a.ts": false,
    "secrets//a.ts": false,
    "app/src/test/A.ts": false,
    "app/src/test": false,
    "app/src/testutil/A.ts": true,
    "lib/app/src/test/A.ts": true,
    "app/src/test.ts": true,
    "src/generated/m.ts": false,
    "src/generatedX/m.ts": true,
    "lib/src/generated/k.ts": true,
    "pkg{a}/x.ts": false,
    "pkga/x.ts": true,
    "a b/c/d.md": false,
    "a b/cd/d.md": true,
    "Docs/r.md": false,
    "docs/r.md": true,
    Dockerfile: true,
    "secrets/Dockerfile": false,
    "x/.env": true,
    "../out/a.ts": false,
    "thurview-scope.yaml": true,
    "notes.txt": false,
    "": false,
    "./": false,
    "src/a.TS": true,
    "app/src/test/deep/x.css": false,
  };

  it("admits and refuses the same paths", () => {
    const s = makeScope(RULES_BEFORE);
    const now = Object.fromEntries(Object.keys(VERDICTS_BEFORE).map((p) => [p, s.inScope(p)]));
    expect(now).toEqual(VERDICTS_BEFORE);
  });

  it("keeps the same entries and the same digest, so no symbol cache or sealed revision moves", () => {
    const s = makeScope(RULES_BEFORE);
    expect(s.exclude).toEqual([
      "Docs",
      "a b/c",
      "app/src/test",
      "pkg{a}",
      "secrets",
      "src/generated",
    ]);
    expect(s.digest).toBe("0acc2e9c1030");
  });
});

describe("publish seals only what the globs allow", () => {
  it("counts a change a glob withholds as withheld at scaffold", async () => {
    const ev = await cli(["scaffold"]);
    reviewId = ev["review"].uuid as string;
    reviewDir = ev["review"].dir as string;
    // module-a/src/a.ts and a/b/test/deep.ts are in; module-a/test/a.test.ts and
    // pkg/x/fixtures/f.ts are held out by a glob and by nothing else
    expect(ev["scopeWithheld"]).toBe("2 of 4 changed files");
  }, 30_000);

  it("refuses a peek into a directory only a glob withholds", async () => {
    await writeFile(
      join(reviewDir, "data.yaml"),
      `architecture: { view: The source stays in its module. }\nanchors:\n  leak:\n    title: A module's test\n    peek: { file: module-b/test/b.test.ts, from: 1, to: 1 }\n`,
    );
    await writeFile(join(reviewDir, "review.md"), `# Globs\n\n**Summary**\n\n- Globbed.\n`);
    const out = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(out["code"]).toBe("PUBLISH_FAILED");
    const messages = (out["diagnostics"] as Out[]).map((d) => String(d["message"])).join("\n");
    expect(messages).toContain("module-b/test/b.test.ts");
    expect(messages).toContain(SCOPE_FILE);
    await expect(readdir(join(reviewDir, "revisions"))).rejects.toThrow();
  }, 30_000);

  it("seals the revision and the map without what the globs withhold", async () => {
    await writeFile(
      join(reviewDir, "data.yaml"),
      `architecture: { view: The source stays in its module. }\nanchors:\n  step:\n    title: The step\n    peek: { file: module-a/src/a.ts, from: 1, to: 2 }\n`,
    );
    await writeFile(
      join(reviewDir, "review.md"),
      `# Globs\n\n**Summary**\n\n- a now steps by two: [the step](anchor:step).\n`,
    );
    await writeFile(
      join(reviewDir, "map.yaml"),
      [
        "nodes:",
        "  - { id: a, label: Module A, kind: container, files: [module-a/**] }",
        "  - { id: fx, label: Fixtures, kind: container, files: [fixtures/**] }",
        "edges: []",
        "",
      ].join("\n"),
    );
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(1);
    expect(out["scope"].withheld).toBe(2);
    const messages = ((out["diagnostics"] as Out[]) ?? []).map((d) => String(d["message"]));
    // the map node that points only into a glob-withheld tree is named as such
    expect(messages.join("\n")).toContain('every file matching "fixtures/**"');

    const rev = join(reviewDir, "revisions", "1");
    const changes = JSON.parse(await readFile(join(rev, "changes.json"), "utf8")) as {
      path: string;
    }[];
    expect(changes.map((c) => c.path)).toEqual(["a/b/test/deep.ts", "module-a/src/a.ts"]);

    const sealed = await readdir(rev);
    for (const f of sealed) {
      const text = await readFile(join(rev, f), "utf8").catch(() => "");
      expect(text, f).not.toContain(SECRET_MARKER);
      expect(text, f).not.toContain("module-a/test/");
      expect(text, f).not.toContain("pkg/x/fixtures");
    }

    const { stdout } = await execFileP("grep", ["-rl", SECRET_MARKER, home]).catch(() => ({
      stdout: "",
    }));
    expect(stdout.trim()).toBe("");
    await rm(join(reviewDir, "map.yaml"));
  }, 60_000);

  it("warns about a glob that matches nothing, and not about the ones that match", async () => {
    const out = await cli(["publish", "--review", reviewId]);
    const rows = (out["diagnostics"] as Out[]) ?? [];
    const typo = rows.find((d) => String(d["message"]).includes('"*/tset"'));
    expect(typo).toBeDefined();
    expect(String(typo!["level"])).toBe("warning");
    expect(String(typo!["message"])).toContain("withholds nothing");
    const text = rows.map((d) => String(d["message"])).join("\n");
    expect(text).not.toContain('"*/test" matches no');
    expect(text).not.toContain('"**/fixtures" matches no');
  }, 60_000);

  it("records the globs in the sealed revision exactly as they were written", async () => {
    const meta = JSON.parse(
      await readFile(join(reviewDir, "revisions", "1", "meta.json"), "utf8"),
    ) as { scope: { exclude: string[]; digest: string } };
    expect(meta.scope.exclude).toEqual(["**/fixtures", "*/test", "*/tset"]);
    const now = makeScope({ extensions: ["ts", "md", "woff2"], exclude: meta.scope.exclude });
    expect(meta.scope.digest).toBe(now.digest);
  });
});

describe("every reading route applies the globs, over HTTP", () => {
  it("refuses a glob-withheld file by saying so on /file and /diff", async () => {
    for (const path of ["module-a/test/a.test.ts", "pkg/x/fixtures/f.ts", "fixtures/root.ts"]) {
      const f = await get(`/api/reviews/${reviewId}/file?path=${encodeURIComponent(path)}`);
      expect(f.status, path).toBe(403);
      expect(f.json.error, path).toContain("excluded by scope");
      expect(f.text, path).not.toContain(SECRET_MARKER);
    }
    const d = await get(`/api/reviews/${reviewId}/diff?path=module-a/test/a.test.ts`);
    expect(d.status).toBe(403);
    expect(d.json.error).toContain("excluded by scope");

    // spelt the long way round, which git would still read
    const s = await get(
      `/api/reviews/${reviewId}/file?path=${encodeURIComponent("././module-a//test/a.test.ts")}`,
    );
    expect(s.status).toBe(403);
  });

  it("serves what a glob does not reach", async () => {
    for (const path of ["a/b/test/deep.ts", "module-a/testing/t.ts", "module-a/src/a.ts"]) {
      const f = await get(`/api/reviews/${reviewId}/file?path=${encodeURIComponent(path)}`);
      expect(f.status, path).toBe(200);
    }
    const d = await get(`/api/reviews/${reviewId}/diff?path=a/b/test/deep.ts`);
    expect(d.status).toBe(200);
  });

  it("answers /symbols without a name a glob-withheld file defines", async () => {
    for (const name of [MODULE_TEST_SYMBOL, ROOT_FIXTURE_SYMBOL]) {
      const r = await get(`/api/reviews/${reviewId}/symbols?name=${name}`);
      expect(r.status, name).toBe(200);
      expect(r.json, name).toEqual([]);
    }
    const kept = await get(`/api/reviews/${reviewId}/symbols?name=${DEEP_TEST_SYMBOL}`);
    expect(kept.json).toHaveLength(1);
    expect(kept.json[0].path).toBe("a/b/test/deep.ts");
  }, 30_000);

  it("filters glob-withheld paths out of /commits and /changes", async () => {
    const c = await get(`/api/reviews/${reviewId}/commits`);
    expect(c.status).toBe(200);
    expect(c.json[0].files).toEqual(["a/b/test/deep.ts", "module-a/src/a.ts"]);
    const ch = await get(`/api/reviews/${reviewId}/changes`);
    expect(ch.json.map((x: { path: string }) => x.path)).toEqual([
      "a/b/test/deep.ts",
      "module-a/src/a.ts",
    ]);
  });
});

describe("a revision sealed under globs, read back under other rules", () => {
  it("compares a sealed glob as written: extending it by whole segments narrows nothing", () => {
    const sealed = { declared: true, extensions: ["ts"], filenames: [], exclude: ["*/test"] };
    // dropping the glob widens: everything the revision holds is still allowed
    expect(allowsEverything(makeScope({ extensions: ["ts"] }), sealed)).toBe(true);
    // a deeper entry under the sealed one withholds only what it already withheld
    expect(allowsEverything(makeScope({ extensions: ["ts"], exclude: ["*/test/x"] }), sealed)).toBe(
      true,
    );
    // a different glob can withhold what the revision holds
    expect(allowsEverything(makeScope({ extensions: ["ts"], exclude: ["**/test"] }), sealed)).toBe(
      false,
    );
    expect(allowsEverything(makeScope({ extensions: ["ts"], exclude: ["*/src"] }), sealed)).toBe(
      false,
    );
  });

  it("serves it after a glob is dropped, and refuses it once a new glob narrows the rules", async () => {
    // widen: drop `*/test`
    await write(
      SCOPE_FILE,
      ["extensions: [ts, md, woff2]", "exclude:", '  - "**/fixtures"', '  - "*/tset"', ""].join(
        "\n",
      ),
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "widen: read module tests");
    await cli(["scaffold", "--update", "--review", reviewId]);
    // the latest revision (the warning case above published a second one under
    // the same rules) was sealed under `*/test`, which the rules no longer hold
    const wide = await get(`/api/reviews/${reviewId}`);
    expect(wide.status).toBe(200);
    expect(wide.json.scope.exclude).toEqual(["**/fixtures", "*/tset"]);

    // narrow: a new glob that holds out what that revision sealed
    await write(
      SCOPE_FILE,
      [
        "extensions: [ts, md, woff2]",
        "exclude:",
        '  - "**/fixtures"',
        '  - "*/tset"',
        '  - "*/src"',
        "",
      ].join("\n"),
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "narrow: withhold module sources");
    await cli(["scaffold", "--update", "--review", reviewId]);
    const narrow = await get(`/api/reviews/${reviewId}`);
    expect(narrow.status).toBe(409);
    expect(narrow.json.error).toContain("excluded by scope");
    expect(narrow.text).not.toContain("n + 2");
  }, 60_000);
});
