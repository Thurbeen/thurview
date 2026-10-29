/** Rules are exercised through publish, sealed files, HTTP and HTML export. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeScope, scopeAt, ScopeError, OPEN_SCOPE, SCOPE_FILE } from "../src/scope.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

/** Synthetic, and the only strings this suite ever plants in a withheld file. */
const SECRET_MARKER = "AKIAIOSFODNN7EXAMPLE";
const EXCLUDED_SYMBOL = "generatedOnlySymbol";
const POSITIONAL_SYMBOL = "positionallyKept";
const RENAMED_SYMBOL = "renamedOutOfSecrets";

let repo: string;
let home: string;
let server: { port: number; close(): Promise<void> };
let reviewId = "";
let reviewDir = "";
let headSha = "";

type Out = Record<string, any>;

async function cli(args: string[], opts: { expectCode?: number; cwd?: string } = {}): Promise<Out> {
  const env = { ...process.env, THURVIEW_HOME: home };
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd: opts.cwd ?? repo, env },
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

/** The routes are asked over HTTP, so the status code is part of every answer. */
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
  home = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-scope-home-"));
  repo = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-scope-repo-"));
  await git("init", "-q", "-b", "main");

  // The rules: an allowlist of extensions, a separate list of bare file names,
  // and directory exclusions matched from the first segment of the path.
  await write(
    SCOPE_FILE,
    [
      "extensions: [ts, md, css]",
      "filenames: [Dockerfile]",
      "exclude:",
      "  - secrets",
      "  - src/generated",
      "",
    ].join("\n"),
  );
  await write(
    "src/app.ts",
    `export function login(user: string) {\n  return user.length > 0;\n}\n`,
  );
  // allowed: extensionless, reachable only through `filenames`
  await write("Dockerfile", "FROM scratch\n");
  // An allowed extension inside an excluded directory tests the symbol index.
  await write("src/generated/model.ts", `export function ${EXCLUDED_SYMBOL}() {\n  return 1;\n}\n`);
  // the same directory name deeper in the tree: `exclude` is positional, so this
  // one stays in scope. An any-segment rule would drop it.
  await write(
    "lib/src/generated/keep.ts",
    `export function ${POSITIONAL_SYMBOL}() {\n  return 2;\n}\n`,
  );
  // excluded by directory, and by extension too
  await write("secrets/keystore.properties", `aws_access_key_id=${SECRET_MARKER}\n`);
  // an allowed extension inside an excluded directory, for the content routes
  await write("secrets/brand.css", ":root{--leak:1}\n");
  await write("assets/brand.css", ":root{--ok:1}\n");
  // an extension the allowlist never names: withheld by absence, which is the
  // property an ignore list cannot have
  await write("notes.txt", "plain notes\n");
  // The "before" of the rename the feature commit makes: an allowed extension
  // inside an excluded directory. No marker in it, because this case is about the
  // PATH - at head the file is allowed and readable, and it is the diff against
  // the withheld side that cannot be shown.
  await write("secrets/token.ts", `export const ${RENAMED_SYMBOL} = 3;\n`);
  await git("add", ".");
  await git("commit", "-q", "-m", "base");

  await git("checkout", "-q", "-b", "feature");
  await write(
    "src/app.ts",
    `export function login(user: string) {\n  return user.trim().length > 0;\n}\n`,
  );
  await write("secrets/keystore.properties", `aws_access_key_id=${SECRET_MARKER}\nrotated=1\n`);
  await write("notes.txt", "plain notes\nand more\n");
  // A rename out of an excluded directory into an allowed one. Both sides have
  // to be readable for the change to be shown, or the file list names a path
  // whose diff nobody may read.
  await git("mv", "secrets/token.ts", "src/token.ts");
  await git("add", ".");
  await git(
    "commit",
    "-q",
    "-m",
    "trim the user before checking it",
    "-m",
    "A body, kept verbatim: a path scope is about paths and does not touch commit prose.",
  );
  headSha = (await git("rev-parse", "HEAD")).stdout.trim();

  process.env["THURVIEW_HOME"] = home;
  // What `thurview serve` runs, with the host list held to loopback so the suite
  // does not open a port on the tailnet the way the command's default would.
  const { startServer } = await import("../src/server/server.ts");
  server = await startServer({ hosts: ["127.0.0.1"] });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("the matcher", () => {
  const scope = makeScope({
    extensions: [".TS", "md"],
    filenames: ["Dockerfile", ".gitattributes"],
    exclude: ["secrets/", "app/src/test"],
  });

  it("allows only what is listed, so an unlisted type fails by absence", () => {
    expect(scope.inScope("src/app.ts")).toBe(true);
    expect(scope.inScope("README.md")).toBe(true);
    expect(scope.inScope("app.jks")).toBe(false);
    expect(scope.inScope("google-services.json")).toBe(false);
    expect(scope.inScope("notes.txt")).toBe(false);
  });

  it("takes bare file names from their own list, because thurview is language-agnostic", () => {
    expect(scope.inScope("Dockerfile")).toBe(true);
    expect(scope.inScope("build/Dockerfile")).toBe(true);
    expect(scope.inScope(".gitattributes")).toBe(true);
    expect(scope.inScope("Makefile")).toBe(false);
  });

  it("excludes a directory from the first segment, not at any segment", () => {
    expect(scope.inScope("app/src/test/Helper.ts")).toBe(false);
    expect(scope.inScope("app/src/testutil/Helper.ts")).toBe(true);
    // the case an any-segment rule gets wrong: a real package deeper in the tree
    expect(scope.inScope("lib/app/src/test/Helper.ts")).toBe(true);
    expect(scope.inScope("secrets/keystore.properties")).toBe(false);
  });

  it("canonicalises the path the way git does, so no spelling walks past exclude", () => {
    // `git show <rev>:././secrets/x.css` reads the file, so the matcher has to
    // answer about the same path git would read. Stripping one leading `./` is
    // not idempotent, and `././` walked straight through.
    expect(scope.inScope("././secrets/x.css")).toBe(false);
    expect(scope.inScope(".//./secrets/x.css")).toBe(false);
    expect(scope.inScope("/./secrets/x.css")).toBe(false);
    expect(scope.inScope("secrets//x.css")).toBe(false);
    expect(scope.inScope("./src/a.ts")).toBe(true);
    expect(scope.inScope("../outside/a.ts")).toBe(false);
  });

  it("keeps the rules themselves readable, so a reader can read what withheld a file", () => {
    expect(scope.inScope(SCOPE_FILE)).toBe(true);
  });

  it("refuses an entry that cannot match, rather than counting it as a rule", () => {
    // These fail closed, so the damage is hidden files - but the verdict counts
    // them as rules in force, and "1 extension" that never matches is not one.
    expect(() => makeScope({ extensions: ["*.ts"] })).toThrow(/bare suffix/);
    expect(() => makeScope({ extensions: ["tar.gz"] })).toThrow(/only the last suffix/);
    expect(() => makeScope({ filenames: ["src/Dockerfile"] })).toThrow(/whole file name/);
  });

  it("refuses an allowlist that allows nothing", () => {
    expect(() => makeScope({ exclude: ["secrets"] })).toThrow(ScopeError);
  });

  it("refuses an unknown key rather than ignoring a misspelt rule", () => {
    expect(() => makeScope({ extensions: ["ts"], excludes: ["secrets"] })).toThrow(ScopeError);
  });

  it("gives different rules different digests, which is what the caches key on", () => {
    expect(makeScope({ extensions: ["ts"] }).digest).not.toBe(
      makeScope({ extensions: ["ts", "md"] }).digest,
    );
    expect(makeScope({ extensions: ["ts", "md"] }).digest).toBe(
      makeScope({ extensions: ["md", ".TS"] }).digest,
    );
    expect(OPEN_SCOPE.digest).toBe("open");
  });
});

describe("the rules are read from the repository under review", () => {
  it("reads them at the pinned commit, and reports no rules when the file is absent", async () => {
    const scope = await scopeAt(repo, headSha);
    expect(scope.declared).toBe(true);
    expect(scope.extensions).toEqual(["css", "md", "ts"]);
    expect(scope.filenames).toEqual(["Dockerfile"]);
    expect(scope.exclude).toEqual(["secrets", "src/generated"]);
    expect(scope.verdict).toContain(SCOPE_FILE);
  });

  it("refuses malformed rules instead of falling back to reviewing everything", async () => {
    const bad = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-scope-bad-"));
    try {
      await execFileP("git", ["init", "-q", "-b", "main"], { cwd: bad });
      await writeFile(join(bad, SCOPE_FILE), "extensions: [ts\n");
      await execFileP("git", ["add", "."], { cwd: bad });
      await execFileP("git", ["commit", "-q", "-m", "rules"], {
        cwd: bad,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      const sha = (await execFileP("git", ["rev-parse", "HEAD"], { cwd: bad })).stdout.trim();
      await expect(scopeAt(bad, sha)).rejects.toThrow(ScopeError);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe("an unreadable declared scope fails closed", () => {
  it("refuses a missing rules blob instead of treating the tree as unscoped", async () => {
    const dir = await mkdtemp(join(ROOT, "node_modules", ".cache", "scope-missing-blob-"));
    const g = async (...args: string[]) =>
      (
        await execFileP(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { cwd: dir },
        )
      ).stdout.trim();
    try {
      await g("init", "-q");
      await writeFile(join(dir, SCOPE_FILE), "extensions: [ts]\n");
      await g("add", ".");
      await g("commit", "-qm", "rules");
      const head = await g("rev-parse", "HEAD");
      const blob = await g("rev-parse", `HEAD:${SCOPE_FILE}`);
      await rm(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      await expect(scopeAt(dir, head)).rejects.toThrow(/exists.*git would not read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("publish seals only what the rules allow", () => {
  it("scaffolds and names the rules, so the agent learns them before it writes anchors", async () => {
    const ev = await cli(["scaffold"]);
    reviewId = ev["review"].uuid as string;
    reviewDir = ev["review"].dir as string;
    expect(ev["scopeRules"]).toContain(SCOPE_FILE);
    // Four files changed: src/app.ts, secrets/keystore.properties, notes.txt and
    // the rename secrets/token.ts -> src/token.ts. Three are withheld, the
    // rename among them: an allowed path whose "before" nobody may read.
    expect(ev["scopeWithheld"]).toBe("3 of 4 changed files");
  }, 30_000);

  it("refuses a peek at an excluded file rather than sealing its source", async () => {
    await writeFile(
      join(reviewDir, "data.yaml"),
      `anchors:\n  leak:\n    title: The keystore\n    peek: { file: secrets/keystore.properties, from: 1, to: 1 }\n`,
    );
    await writeFile(
      join(reviewDir, "review.md"),
      `# Scoped\n\n**Summary**\n\n- A scoped review.\n`,
    );
    const out = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(out["code"]).toBe("PUBLISH_FAILED");
    const messages = (out["diagnostics"] as Out[]).map((d) => String(d["message"])).join("\n");
    expect(messages).toContain("secrets/keystore.properties");
    expect(messages).toContain(SCOPE_FILE);
    // nothing was written, so nothing of that file is on disk
    await expect(readdir(join(reviewDir, "revisions"))).rejects.toThrow();
  }, 30_000);

  it("publishes with an allowed peek and withholds the rest from the sealed revision", async () => {
    await writeFile(
      join(reviewDir, "data.yaml"),
      `architecture: { view: The check stays in the app module. }\nanchors:\n  trim:\n    title: The trim\n    peek: { file: src/app.ts, from: 1, to: 2 }\n`,
    );
    await writeFile(
      join(reviewDir, "review.md"),
      `# Scoped\n\n**Summary**\n\n- The check now trims: [the trim](anchor:trim).\n`,
    );
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(1);
    expect(out["scope"].withheld).toBe(3);
    expect(out["scope"].of).toBe(4);
    expect(String(out["scope"].verdict)).toContain(SCOPE_FILE);

    const rev = join(reviewDir, "revisions", "1");
    const changes = JSON.parse(await readFile(join(rev, "changes.json"), "utf8")) as {
      path: string;
    }[];
    expect(changes.map((c) => c.path)).toEqual(["src/app.ts"]);

    const document = await readFile(join(rev, "document.json"), "utf8");
    expect(document).toContain("trim");
    expect(document).not.toContain(SECRET_MARKER);
    expect(document).not.toContain("keystore.properties");
    expect(document).not.toContain("notes.txt");
    // the withheld side of the rename, which travels with the path that replaced it
    expect(document).not.toContain("secrets/token.ts");

    // and nowhere in the whole store
    const { stdout } = await execFileP("grep", ["-rl", SECRET_MARKER, home]).catch(() => ({
      stdout: "",
    }));
    expect(stdout.trim()).toBe("");
  }, 60_000);
});

describe("every reading route applies the rules, over HTTP", () => {
  it("says a file is excluded by scope rather than claiming it does not exist", async () => {
    const r = await get(`/api/reviews/${reviewId}/file?path=secrets/keystore.properties`);
    expect(r.status).toBe(403);
    expect(r.json.error).toContain("excluded by scope");
    expect(r.json.error).toContain(SCOPE_FILE);
    // a 404 would send the reviewer to open the file by hand
    expect(r.json.error).not.toContain("not found");
    expect(r.text).not.toContain(SECRET_MARKER);
  });

  it("withholds a file the allowlist never names, on /file and on /diff", async () => {
    for (const path of ["notes.txt", "src/generated/model.ts"]) {
      const f = await get(`/api/reviews/${reviewId}/file?path=${encodeURIComponent(path)}`);
      expect(f.status, path).toBe(403);
      expect(f.json.error, path).toContain("excluded by scope");
    }
    const d = await get(`/api/reviews/${reviewId}/diff?path=notes.txt`);
    expect(d.status).toBe(403);
    expect(d.json.error).toContain("excluded by scope");
  });

  it("still serves what the rules allow, including the rules themselves", async () => {
    for (const path of ["src/app.ts", "Dockerfile", "lib/src/generated/keep.ts", SCOPE_FILE]) {
      const f = await get(`/api/reviews/${reviewId}/file?path=${encodeURIComponent(path)}`);
      expect(f.status, path).toBe(200);
      expect(f.json.lines.length, path).toBeGreaterThan(0);
    }
    const d = await get(`/api/reviews/${reviewId}/diff?path=src/app.ts`);
    expect(d.status).toBe(200);
    expect(d.json.hunks.length).toBeGreaterThan(0);
  });

  it("applies them on /symbols, which answers from the symbol index", async () => {
    const excluded = await get(`/api/reviews/${reviewId}/symbols?name=${EXCLUDED_SYMBOL}`);
    expect(excluded.status).toBe(200);
    expect(excluded.json).toEqual([]);
    const kept = await get(`/api/reviews/${reviewId}/symbols?name=${POSITIONAL_SYMBOL}`);
    expect(kept.json).toHaveLength(1);
    expect(kept.json[0].path).toBe("lib/src/generated/keep.ts");
  }, 30_000);

  it("withholds an excluded path however it is spelt, because git resolves the spelling", async () => {
    // `git show <rev>:././secrets/brand.css` reads the excluded file, so a
    // matcher that canonicalises less than git does hands it over. These two
    // forms were served 200 before the matcher became idempotent.
    for (const path of ["././secrets/brand.css", ".//./secrets/brand.css"]) {
      for (const route of ["file", "diff"]) {
        const b = await get(`/api/reviews/${reviewId}/${route}?path=${encodeURIComponent(path)}`);
        expect(b.status).toBe(403);
        expect(b.text).not.toContain("--leak");
      }
    }
    const f = await get(
      `/api/reviews/${reviewId}/file?path=${encodeURIComponent("././src/generated/model.ts")}`,
    );
    expect(f.status).toBe(403);
    expect(f.text).not.toContain(EXCLUDED_SYMBOL);
  });

  it("withholds a rename whose other side is excluded, rather than listing a path it will not diff", async () => {
    // src/token.ts is allowed and its content at head is readable; the diff is
    // not, because the "before" is secrets/token.ts. So the change is withheld
    // whole - listing it and then refusing the diff is the worse of the two.
    const d = await get(`/api/reviews/${reviewId}/diff?path=src/token.ts`);
    expect(d.status).toBe(403);
    expect(d.json.error).toContain("excluded by scope");
    const c = await get(`/api/reviews/${reviewId}/changes`);
    const listed = c.json.map((x: { path: string; oldPath?: string }) => x.path);
    expect(listed).not.toContain("src/token.ts");
    expect(JSON.stringify(c.json)).not.toContain("secrets/token.ts");
    // and the sealed list on disk holds neither side of it
    const sealed = await readFile(join(reviewDir, "revisions", "1", "changes.json"), "utf8");
    expect(sealed).not.toContain("secrets/token.ts");
    expect(sealed).not.toContain("src/token.ts");
  });

  it("filters the path list on /commits and leaves the message alone", async () => {
    const r = await get(`/api/reviews/${reviewId}/commits`);
    expect(r.status).toBe(200);
    const commit = r.json[0];
    // src/token.ts is an allowed path and readable at head, so the commit that
    // touched it says so; its withheld "before" is filtered out of the list, and
    // the change itself is withheld where a diff would be served.
    expect(commit.files).toEqual(["src/app.ts", "src/token.ts"]);
    expect(JSON.stringify(r.json)).not.toContain("secrets/token.ts");
    // a path scope does not touch prose, and the documentation says so
    expect(commit.body).toContain("does not touch commit prose");
  });

  it("filters /changes and tells the reader on the review payload that it did", async () => {
    const c = await get(`/api/reviews/${reviewId}/changes`);
    expect(c.json.map((x: { path: string }) => x.path)).toEqual(["src/app.ts"]);
    // The file list the browser renders comes from the payload below, sealed at
    // publish; this route is what any other client gets, and it is filtered too.
    const p = await get(`/api/reviews/${reviewId}`);
    expect(p.json.scope.declared).toBe(true);
    expect(p.json.scope.withheld).toBe(3);
    expect(p.json.scope.exclude).toEqual(["secrets", "src/generated"]);
    expect(p.json.changes.map((x: { path: string }) => x.path)).toEqual(["src/app.ts"]);
  });
});

describe("an explainer accounts for what the rules withheld", () => {
  it("counts withheld files apart from the ones it simply never examined", async () => {
    const ev = await cli(["explain"]);
    const id = ev["explainer"].uuid as string;
    const dir = ev["explainer"].dir as string;
    await writeFile(
      join(dir, "review.md"),
      `# The repository\n\n**Summary**\n\n- One file, anchored: [login](anchor:login).\n`,
    );
    await writeFile(
      join(dir, "data.yaml"),
      `anchors:\n  login:\n    title: login\n    peek: { file: src/app.ts, from: 1, to: 2 }\n`,
    );
    const out = await cli(["publish", "--review", id]);
    const cov = JSON.parse(
      await readFile(join(dir, "revisions", "1", "coverage.json"), "utf8"),
    ) as import("../src/coverage.ts").Coverage;
    // secrets/keystore.properties, secrets/brand.css, src/generated/model.ts and
    // notes.txt are withheld; they are counted here and listed nowhere
    expect(cov.files.excludedByScope).toBe(4);
    expect(cov.uncovered).not.toContain("secrets/keystore.properties");
    expect(cov.uncovered).not.toContain("notes.txt");
    // ten files at the commit: six in scope, four withheld
    expect(cov.files.total).toBe(6);
    expect(cov.files.total + cov.files.excludedByScope).toBe(10);
    expect(cov.verdict).toContain("withheld by the review scope");
    expect(String(out["published"].coverage)).toContain("withheld by the review scope");
    await cli(["delete", "--review", id]);
  }, 60_000);
});

describe("HTML export applies the same file rules", () => {
  it("omits excluded commit files and does not read an excluded thread target", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/reviews/${reviewId}/threads`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "question",
          mode: "ask",
          body: "Check this file",
          target: { type: "file", path: "././secrets/brand.css", side: "head", from: 1, to: 1 },
        }),
      },
    );
    expect(response.status).toBe(200);
    const file = join(home, "scoped.html");
    await cli(["export", "--review", reviewId, "--out", file]);
    const html = await readFile(file, "utf8");
    const snap = JSON.parse(/id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(JSON.stringify(snap.files)).not.toContain("secrets/");
    expect(JSON.stringify(snap.commits)).not.toContain("secrets/");
    expect(JSON.stringify(snap.diffs)).not.toContain("secrets/");
    expect(snap.files["head:src/app.ts"].lines.join(" ")).toContain("trim");
    expect(JSON.stringify(snap)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(snap.files)).not.toContain("--leak");
    expect(
      snap.payload.threads.some((t: any) =>
        t.messages.some((m: any) => m.body === "Check this file"),
      ),
    ).toBe(true);
    expect(snap.payload.scope.declared).toBe(true);
    if (process.env["THURVIEW_SCOPE_PREVIEW"])
      await writeFile(join(ROOT, "node_modules", "scope-preview.html"), html);
    await rm(file);
  }, 60_000);
});

describe("a revision sealed under other rules is not served under these", () => {
  it("refuses it and names the command that fixes it, rather than serving what it holds", async () => {
    // rev 1 was sealed under the rules at the head commit above; narrow them
    await write(
      SCOPE_FILE,
      ["extensions: [ts]", "filenames: [Dockerfile]", "exclude:", "  - secrets", ""].join("\n"),
    );
    await git("add", ".");
    await git("commit", "-q", "-m", "narrow the review scope to typescript");
    await cli(["scaffold", "--update", "--review", reviewId]);

    const stale = await get(`/api/reviews/${reviewId}`);
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain("excluded by scope");
    expect(stale.json.error).toContain("thurview publish");
    const failedExport = await cli(
      ["export", "--review", reviewId, "--out", join(home, "stale.html")],
      { expectCode: 1 },
    );
    expect(String(failedExport.error)).toContain("excluded by scope");
    await expect(readFile(join(home, "stale.html"))).rejects.toThrow();
    // the sealed peek is not in the refusal
    expect(stale.text).not.toContain("user.trim()");

    // republishing under the rules in force makes it readable again
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(2);
    const fresh = await get(`/api/reviews/${reviewId}`);
    expect(fresh.status).toBe(200);
    expect(fresh.json.scope.extensions).toEqual(["ts"]);
    // and `md` is gone from the allowlist, so a markdown file is now withheld too
    expect(fresh.json.scope.declared).toBe(true);
  }, 60_000);
});

describe("widening the rules does not cost the reader the history", () => {
  it("serves a revision sealed under narrower rules, and keeps the number it was sealed with", async () => {
    // rev 2 above was sealed under `extensions: [ts]`, `exclude: [secrets]`.
    // Widening cannot make anything it holds withheld, so refusing it would be a
    // cost with nothing bought. Narrowing is the case the refusal is for.
    const sealedWithheld = (
      JSON.parse(await readFile(join(reviewDir, "revisions", "2", "meta.json"), "utf8")) as {
        scope: { withheld: number };
      }
    ).scope.withheld;

    await write(
      SCOPE_FILE,
      ["extensions: [ts, md]", "filenames: [Dockerfile]", "exclude:", "  - secrets", ""].join("\n"),
    );
    // and one more withheld file in the same commit, so the live count of what
    // the rules hold back is higher than the count rev 2 was sealed with
    await write("secrets/extra.properties", `aws_secret_access_key=${SECRET_MARKER}\n`);
    await write("secrets/keystore.properties", `aws_access_key_id=${SECRET_MARKER}\nrotated=2\n`);
    await write("notes.txt", "plain notes\nand more\nand more again\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "widen the review scope back to markdown");
    await cli(["scaffold", "--update", "--review", reviewId]);

    const p = await get(`/api/reviews/${reviewId}`);
    expect(p.status).toBe(200);
    expect(p.json.scope.extensions).toEqual(["md", "ts"]);
    // the file list is rev 2's, so the count over it has to be rev 2's too
    expect(p.json.scope.withheld).toBe(sealedWithheld);
    // rev 2's own pins took in the commit that narrowed the rules, so the file it
    // is declared in is part of that change - and always readable
    expect(p.json.changes.map((x: { path: string }) => x.path)).toEqual(["src/app.ts", SCOPE_FILE]);
  }, 60_000);
});

describe("a sealed revision stays readable when its repository does not", () => {
  it("serves the published document with the repository gone, as it did before any of this", async () => {
    // The payload is read off disk. Nothing about a declared scope may put a
    // `git diff` on that path: a repository that moved, was unmounted or had its
    // pins garbage-collected would take the published document down with it.
    const gone = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-scope-gone-"));
    const g = (...a: string[]) =>
      execFileP("git", a, {
        cwd: gone,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    await g("init", "-q", "-b", "main");
    await writeFile(join(gone, "a.ts"), "export const a = 1;\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "base");
    await g("checkout", "-q", "-b", "feature");
    await writeFile(join(gone, "a.ts"), "export const a = 2;\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "bump");
    const ev = await cli(["scaffold"], { cwd: gone });
    const id = ev["review"].uuid as string;
    const rdir = ev["review"].dir as string;
    await writeFile(join(rdir, "review.md"), "# Gone\n\n**Summary**\n\n- One line.\n");
    await writeFile(
      join(rdir, "data.yaml"),
      "architecture: { view: The source stays in its module. }\nanchors: {}\n",
    );
    await cli(["publish", "--review", id], { cwd: gone });

    await rm(gone, { recursive: true, force: true });
    const p = await get(`/api/reviews/${id}`);
    expect(p.status).toBe(200);
    expect(p.json.document.title).toBe("Gone");
    expect(p.json.scope.declared).toBe(false);
  }, 60_000);
});

describe("what publish says when the rules hold back something it was told to use", () => {
  /**
   * Its own repository, because both cases are publish-time diagnostics and the
   * suite above measures counts on the shared fixture. Nothing here reaches the
   * server: a failed publish writes no revision, and the warning case is about
   * what the author is told.
   */
  let dir = "";
  let rdir = "";
  let id = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-scope-assets-"));
    const g = (...a: string[]) =>
      execFileP("git", a, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    const put = async (rel: string, body: string) => {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), body);
    };
    await g("init", "-q", "-b", "main");
    // An allowlist written for source, which is what an allowlist looks like:
    // nobody puts `woff2` in one.
    // `Secrets` is the case typo: it withholds nothing, and publish has to say so
    await put(SCOPE_FILE, "extensions: [ts]\nexclude:\n  - secrets\n  - Secrets\n");
    await put("src/app.ts", "export const one = 1;\n");
    await put("secrets/Inter.woff2", "not really a font, but committed where it is\n");
    await put("secrets/gen.ts", "export const two = 2;\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "base");
    await g("checkout", "-q", "-b", "feature");
    await put("src/app.ts", "export const one = 11;\n");
    await g("add", ".");
    await g("commit", "-q", "-m", "bump");
    const ev = await cli(["scaffold"], { cwd: dir });
    id = ev["review"].uuid as string;
    rdir = ev["review"].dir as string;
    await writeFile(join(rdir, "review.md"), "# Assets\n\n**Summary**\n\n- One line.\n");
    await writeFile(
      join(rdir, "data.yaml"),
      "architecture: { view: The source stays in its module. }\nanchors: {}\n",
    );
  }, 60_000);

  afterAll(async () => {
    await cli(["delete", "--review", id], { cwd: dir }).catch(() => ({}));
    await rm(dir, { recursive: true, force: true });
  });

  it("names the rules when a map node points only into withheld paths", async () => {
    await writeFile(
      join(rdir, "map.yaml"),
      [
        "nodes:",
        "  - { id: app, label: App, kind: container, files: [src/**] }",
        "  - { id: gen, label: Generated, kind: container, files: [secrets/**] }",
        "edges: []",
        "",
      ].join("\n"),
    );
    const out = await cli(["publish", "--review", id], { cwd: dir });
    const messages = (out["diagnostics"] as Out[]).map((d) => String(d["message"])).join("\n");
    // the glob DOES match files at the commit, so "no file matches" would send the
    // author looking for a typo that is not there
    expect(messages).toContain("excluded by the review scope");
    expect(messages).toContain(SCOPE_FILE);
    expect(messages).not.toContain('no file matches "secrets/**"');
    await rm(join(rdir, "map.yaml"));
  }, 60_000);

  it("says when an exclude entry matches nothing, because that entry opens a path", async () => {
    const out = await cli(["publish", "--review", id], { cwd: dir });
    const rows = (out["diagnostics"] as Out[]) ?? [];
    const warning = rows.find((d) => String(d["message"]).includes('"Secrets"'));
    expect(warning).toBeDefined();
    expect(String(warning!["level"])).toBe("warning");
    expect(String(warning!["message"])).toContain("withholds nothing");
    // and the entry that does match is not complained about
    expect(rows.map((d) => String(d["message"])).join("\n")).not.toContain('"secrets" matches no');
  }, 60_000);
});
