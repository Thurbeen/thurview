import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

let repo: string;
let home: string;
let server: { port: number; close(): Promise<void> };
let reviewId = "";
let reviewDir = "";

async function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  return execFileP(cmd, args, { cwd, env: { ...process.env, ...env } });
}

type Out = Record<string, any>;
async function cli(args: string[], opts: { cwd?: string; expectCode?: number } = {}): Promise<Out> {
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
        reject(
          new Error(`bad TOON from thurview ${args.join(" ")}: ${(e as Error).message}\n${out}`),
        );
      }
    });
  });
}

const git = (...a: string[]) =>
  sh(repo, "git", a, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  return (await r.json()) as T;
}
const post = (path: string, body: unknown) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "thurview-home-"));
  repo = await mkdtemp(join(tmpdir(), "thurview-repo-"));
  await git("init", "-q", "-b", "main");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    `export function login(user: string) {\n  return check(user);\n}\n\nfunction check(user: string) {\n  return user.length > 0;\n}\n`,
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  await git("checkout", "-q", "-b", "feature");
  await writeFile(
    join(repo, "src", "auth.ts"),
    `import { audit } from "./audit";\n\nexport function login(user: string) {\n  audit(user);\n  return check(user);\n}\n\nfunction check(user: string) {\n  return user.length > 0;\n}\n`,
  );
  await writeFile(
    join(repo, "src", "audit.ts"),
    `export function audit(user: string) {\n  console.log("login", user);\n}\n`,
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "audit logins");
  // surface: one export withdrawn, one added, one signature widened, one body edited
  await git("checkout", "-q", "-b", "surface");
  await writeFile(
    join(repo, "src", "audit.ts"),
    `function audit(user: string, ip: string) {\n  console.log("login", user, ip);\n}\n\nexport function record(user: string, ip: string) {\n  audit(user, ip);\n}\n`,
  );
  await writeFile(
    join(repo, "src", "auth.ts"),
    `import { record } from "./audit";\n\nexport function login(user: string, ip: string) {\n  record(user, ip);\n  return check(user);\n}\n\nfunction check(user: string) {\n  return user.trim().length > 0;\n}\n`,
  );
  await writeFile(join(repo, "notes.md"), "# notes\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "record logins with the client ip");
  // refactor: a private body edited and nothing else
  await git("checkout", "-q", "-b", "refactor");
  await writeFile(
    join(repo, "src", "auth.ts"),
    `import { record } from "./audit";\n\nexport function login(user: string, ip: string) {\n  record(user, ip);\n  return check(user);\n}\n\nfunction check(user: string) {\n  const trimmed = user.trim();\n  return trimmed.length > 0;\n}\n`,
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "name the trimmed user");
  await git("checkout", "-q", "feature");
  process.env["THURVIEW_HOME"] = home;
  const { startServer } = await import("../src/server/server.ts");
  server = await startServer({ hosts: ["127.0.0.1"] });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe("thurview end to end", () => {
  it("shows a definitive empty state and a home view", async () => {
    const empty = await cli([]);
    expect(empty["bin"]).toMatch(/main\.ts$/);
    expect(empty["description"]).toBeTruthy();
    expect(String(empty["reviews"])).toMatch(/^0 reviews bound to/);
    expect(empty["help"]).toEqual(
      expect.arrayContaining([expect.stringContaining("thurview scaffold")]),
    );
    const v = await cli(["--version"]);
    expect(String(v)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fails loudly on unknown flags with exit code 2", async () => {
    const bad = await cli(["info", "--al"], { expectCode: 2 });
    expect(bad["error"]).toContain("--al");
    expect(bad["code"]).toBe("VALIDATION_ERROR");
    expect(String(bad["help"])).toContain("--all");
  });

  it("scaffolds a review pinned to merge-base..head", async () => {
    const ev = await cli(["scaffold"]);
    const r = ev["review"];
    reviewId = r.uuid;
    reviewDir = r.dir;
    const { stdout: head } = await sh(repo, "git", ["rev-parse", "HEAD"]);
    const { stdout: base } = await sh(repo, "git", ["rev-parse", "main"]);
    expect(r.head).toBe(head.trim());
    expect(r.base).toBe(base.trim());
    expect(ev["change"].files).toBe(2);
    expect(ev["help"].length).toBeGreaterThan(0);
    const home = await cli([]);
    expect(home["reviews"]).toHaveLength(1);
    expect(home["reviews"][0].status).toBe("draft");
  });

  it("publishes the untouched stub, so the reader can read the diff before the walkthrough", async () => {
    const ev = await cli(["scaffold", "--new"]);
    const id = ev["review"].uuid as string;
    expect(id).not.toBe(reviewId);
    const out = await cli(["publish", "--review", id, "--view", "files"]);
    expect(out["published"].rev).toBe(1);
    expect(out["diagnostics"]).toBeUndefined();
    const p = await api<{
      document: { title: string; anchors: Record<string, unknown>; blocks: { type: string }[] };
    }>(`/api/reviews/${id}`);
    expect(p.document.title).toBe("feature");
    expect(Object.keys(p.document.anchors)).toEqual([]);
    expect(p.document.blocks.length).toBeGreaterThan(0);
    await cli(["delete", "--review", id]);
  }, 20_000);

  it("graphs the change: symbols touched, edges added, reach and tests", async () => {
    expect(reviewId).toBeTruthy();
    const impact = await cli(["graph", "impact", "--review", reviewId]);
    const changed = impact["changed"] as Out[];
    expect(changed.map((s) => `${s["symbol"]}@${s["file"]}:${s["change"]}`).sort()).toEqual([
      "audit@src/audit.ts:added",
      "login@src/auth.ts:modified",
    ]);
    expect(impact["edges"].added).toEqual(["src/auth.ts:login -> src/audit.ts:audit"]);
    expect(impact["edges"].removed).toEqual([]);
    expect(impact["tests"]).toEqual([]);
    expect((impact["untested"] as string[]).sort()).toEqual([
      "src/audit.ts:audit",
      "src/auth.ts:login",
    ]);
  });

  it("answers callers and tests-for at either pinned commit", async () => {
    const head = await cli(["graph", "callers", "audit", "--review", reviewId]);
    expect(head["callers"]).toEqual([{ symbol: "login", file: "src/auth.ts", line: 3, at: 4 }]);
    const base = await cli(["graph", "callers", "check", "--review", reviewId, "--graph", "base"]);
    expect(base["callers"]).toEqual([{ symbol: "login", file: "src/auth.ts", line: 1, at: 2 }]);
    const none = await cli(["graph", "callers", "nothing", "--review", reviewId]);
    expect(none["callers"]).toEqual([]);
    const tests = await cli(["graph", "tests-for", "login", "--review", reviewId]);
    expect(tests["tests"]).toEqual([]);
  });

  it("derives the architecture at head and its diff against base", async () => {
    const arch = await cli(["graph", "architecture", "--review", reviewId]);
    const files = (arch["communities"] as Out[]).flatMap((c) => c["files"] as string[]);
    expect(files.sort()).toEqual(["src/audit.ts", "src/auth.ts"]);
    expect(arch["diff"].added).toEqual(["src/auth.ts -> src/audit.ts"]);
    expect(arch["diff"].removed).toEqual([]);
  });

  it("names the interfaces a change adds, changes and removes", async () => {
    const ev = await cli(["scaffold", "--base", "feature", "--head", "surface"]);
    const id = ev["review"].uuid as string;
    const out = await cli(["graph", "interfaces", "--review", id]);
    const rows = out["interfaces"] as Out[];
    // removed first: it is the entry a reviewer must not miss
    expect(rows.map((r) => `${r["change"]} ${r["id"]}`)).toEqual([
      "removed src/audit.ts:audit",
      "changed src/auth.ts:login",
      "added src/audit.ts:record",
    ]);
    const changed = rows.find((r) => r["change"] === "changed")!;
    expect(changed["name"]).toBe("export function login(user: string, ip: string)");
    expect(changed["was"]).toBe("export function login(user: string)");
    expect(changed["graph"]).toBe("head");
    expect(rows.find((r) => r["change"] === "removed")!["graph"]).toBe("base");
    expect(rows.find((r) => r["change"] === "added")!["was"]).toBe("");
    // check() changed inside without moving its surface; markdown is outside the graph
    expect(out["internal"]).toBe(1);
    expect(out["unreadable"]).toEqual(["notes.md"]);
    expect(String(out["verdict"])).toBe(
      "1 removed, 1 changed, 1 added. 1 changed file is outside the code graph.",
    );
    await cli(["delete", "--review", id]);
  }, 30_000);

  it("says plainly when a change moves no interface", async () => {
    const ev = await cli(["scaffold", "--base", "surface", "--head", "refactor"]);
    const id = ev["review"].uuid as string;
    const out = await cli(["graph", "interfaces", "--review", id]);
    expect(out["interfaces"]).toEqual([]);
    expect(out["internal"]).toBe(1);
    expect(String(out["verdict"])).toBe(
      "No interface moved. 1 symbol changed inside, with no visible surface.",
    );
    await cli(["delete", "--review", id]);
  }, 30_000);

  it("rejects bad graph sub-commands and flags with exit code 2", async () => {
    const badSub = await cli(["graph", "nonsense", "--review", reviewId], { expectCode: 2 });
    expect(badSub["code"]).toBe("VALIDATION_ERROR");
    const noName = await cli(["graph", "callers", "--review", reviewId], { expectCode: 2 });
    expect(noName["code"]).toBe("VALIDATION_ERROR");
    const badDepth = await cli(
      ["graph", "tests-for", "login", "--review", reviewId, "--depth", "0"],
      { expectCode: 2 },
    );
    expect(badDepth["code"]).toBe("VALIDATION_ERROR");
    const badSide = await cli(
      ["graph", "callers", "login", "--review", reviewId, "--graph", "sideways"],
      { expectCode: 2 },
    );
    expect(badSide["code"]).toBe("VALIDATION_ERROR");
  });

  it("rejects a document whose anchors do not resolve", async () => {
    expect(reviewDir).toBeTruthy();
    await writeFile(
      join(reviewDir, "data.yaml"),
      `anchors:\n  bad:\n    title: Bad\n    peek: { file: src/auth.ts, from: 1, to: 99 }\n`,
    );
    await writeFile(join(reviewDir, "review.md"), `# Title\n\nSee [bad](anchor:bad).\n`);
    const out = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(out["code"]).toBe("PUBLISH_FAILED");
    expect(
      out["diagnostics"].some((d: Out) => String(d["message"]).includes("peek ends at 99")),
    ).toBe(true);
  }, 20_000);

  it("publishes a valid document with every component", async () => {
    expect(reviewDir).toBeTruthy();
    await writeFile(
      join(reviewDir, "data.yaml"),
      `actors:
  caller: { label: Caller }
  auth: { label: Auth }
  log: { label: Audit log }
anchors:
  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }
  auditCall: { title: audit call, detail: New call, peek: { file: src/auth.ts, from: 4, to: 4 } }
  audit: { title: audit(), peek: { file: src/audit.ts, from: 1, to: 3 } }
  check: { title: check(), peek: { file: src/auth.ts, from: 8, to: 10 } }
stores:
  logdb:
    kind: relational
    label: log.db
    tables:
      events: { schema: { id: { type: int, pk: true }, user: { type: text } } }
interfaces:
  auditFn:
    symbol: src/audit.ts:audit
    capability: Any caller can record a login attempt without touching the log file.
  strictFlag:
    name: auth.login --strict
    change: added
    capability: Rejects an empty user instead of answering false.
    anchor: auditCall
`,
    );
    await writeFile(
      join(reviewDir, "map.yaml"),
      `nodes:
  - { id: app, kind: system, label: App }
  - { id: app.auth, kind: component, label: Auth, files: ["src/auth.ts"] }
  - { id: app.audit, kind: component, label: Audit, files: ["src/audit.ts"], anchor: audit }
edges:
  - { from: app.auth, to: app.audit, label: logs logins }
base:
  nodes:
    - { id: app, kind: system, label: App }
    - { id: app.auth, kind: component, label: Auth, files: ["src/auth.ts"] }
  edges: []
`,
    );
    await writeFile(
      join(reviewDir, "review.md"),
      `# Audit every login

**Summary**

- [login](anchor:login) now calls [audit](anchor:audit) before checking the user.

## Data flow

\`\`\`sequence
label: Login
messages:
  - { from: caller, to: auth, label: login(user), anchor: login }
  - { from: auth, to: log, label: audit(user), anchor: auditCall }
  - { from: auth, to: auth, label: check(user), code: "return check(user);" }
\`\`\`

\`\`\`callstack
title: Login path
base: [login, check]
head: [login, { calls: [login, audit], reason: side effect }, check]
\`\`\`

\`\`\`database
title: Audit storage
stores: [logdb]
usecases:
  - id: write
    label: Record a login
    ops:
      - { op: write, store: logdb.events.user, actor: auth, label: append event, anchor: audit }
\`\`\`

## Edge cases {collapsed}

\`\`\`peek
check
\`\`\`
`,
    );
    // a frame that claims an added call must anchor added lines: check() is unchanged
    const doc = await readFile(join(reviewDir, "review.md"), "utf8");
    await writeFile(
      join(reviewDir, "review.md"),
      doc.replace(
        "base: [login, check]\nhead: [login, { calls: [login, audit], reason: side effect }, check]",
        "base: [login]\nhead: [login, check]",
      ),
    );
    const bad = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(
      bad["diagnostics"].some((d: Out) => String(d["message"]).includes("claims an added call")),
    ).toBe(true);
    await writeFile(join(reviewDir, "review.md"), doc);
    // an annotation of a symbol the change did not expose, and an authored entry
    // whose anchor proves nothing, are both rejected rather than published
    const data = await readFile(join(reviewDir, "data.yaml"), "utf8");
    await writeFile(
      join(reviewDir, "data.yaml"),
      data.replace("symbol: src/audit.ts:audit", "symbol: src/auth.ts:check"),
    );
    const stale = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(
      stale["diagnostics"].some((d: Out) =>
        String(d["message"]).includes('no interface change for symbol "src/auth.ts:check"'),
      ),
    ).toBe(true);
    await writeFile(
      join(reviewDir, "data.yaml"),
      data.replace("anchor: auditCall", "anchor: check"),
    );
    const unproven = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(
      unproven["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("has no added lines in the pinned diff"),
      ),
    ).toBe(true);
    await writeFile(join(reviewDir, "data.yaml"), data);
    await writeFile(
      join(reviewDir, "theme.yaml"),
      `name: demo-light\nsource: test\nmode: light\ncolors: { bg: "#ffffff", fg: "#111827", accent: "#2563eb" }\nshape: { radius: 6px }\ncode: { keyword: "#123456" }\nfonts: { files: [{ family: Missing, path: fonts/nope.woff2 }] }\n`,
    );
    const badFont = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(
      badFont["diagnostics"].some((d: Out) => String(d["message"]).includes("fonts/nope.woff2")),
    ).toBe(true);
    await writeFile(
      join(reviewDir, "theme.yaml"),
      `name: demo-light\nsource: test\nmode: light\ncolors: { bg: "#ffffff", fg: "#111827", accent: "#2563eb" }\nshape: { radius: 6px, scanlines: true }\ncode: { keyword: "#123456" }\n`,
    );
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(1);
    expect(out["published"].map).toBe(true);
    expect(out["published"].theme).toBe("demo-light");
    expect(out["published"].interfaces).toBe("2 added.");
    expect(out["diagnostics"]).toBeUndefined();
  }, 20_000);

  it("serves the compiled document, diffs, files, symbols and map", async () => {
    const p = await api<{
      review: { status: string; title: string };
      theme: { name: string; css: string };
      document: {
        blocks: { type: string }[];
        anchors: Record<string, { peek?: { lines: string[] } }>;
        interfaces: {
          entries: { change: string; name: string; capability?: string; anchor?: string }[];
          verdict: string;
          internal: number;
        } | null;
      };
      map: { diff: { added: string[]; changed: string[] }; filesByNode: Record<string, string[]> };
      changes: { path: string }[];
    }>(`/api/reviews/${reviewId}`);
    const ifaces = p.document.interfaces!;
    expect(ifaces.entries.map((e) => `${e.change} ${e.name}`)).toEqual([
      "added export function audit(user: string)",
      "added auth.login --strict",
    ]);
    expect(ifaces.entries[0]!.capability).toContain("record a login attempt");
    expect(ifaces.entries[1]!.anchor).toBe("auditCall");
    expect(ifaces.verdict).toBe("2 added.");
    expect(ifaces.internal).toBe(1);
    expect(p.review.status).toBe("awaiting-review");
    expect(p.theme.name).toBe("demo-light");
    expect(p.theme.css).toContain("--accent: #2563eb");
    expect(p.theme.css).toContain("--radius: 6px");
    expect(p.theme.css).toContain("color-scheme: light;");
    expect(p.theme.css).toContain("body::after");
    expect(p.document.anchors["login"]!.peek!.lines.join("")).toMatch(/#123456/i);
    expect(p.review.title).toBe("Audit every login");
    const types = p.document.blocks.map((b) => b.type);
    expect(types).toEqual(
      expect.arrayContaining(["heading", "html", "sequence", "callstack", "database", "peek"]),
    );
    expect(p.document.anchors["login"]!.peek!.lines).toHaveLength(4);
    expect(p.map.diff.added).toEqual(["app.audit"]);
    expect(p.map.diff.changed).toEqual(["app.auth"]);
    expect(p.map.filesByNode["app.auth"]).toEqual(["src/auth.ts"]);
    expect(p.changes.map((c) => c.path).sort()).toEqual(["src/audit.ts", "src/auth.ts"]);

    const d = await api<{ hunks: { rows: { type: string; html: string }[] }[] }>(
      `/api/reviews/${reviewId}/diff?path=src/auth.ts`,
    );
    expect(d.hunks[0]!.rows.filter((r) => r.type === "add")).toHaveLength(3);
    expect(d.hunks[0]!.rows.map((r) => r.html).join("")).toMatch(/#123456/i);
    const f = await api<{ total: number; lines: string[] }>(
      `/api/reviews/${reviewId}/file?path=src/auth.ts&graph=base&from=1&to=3`,
    );
    expect(f.total).toBe(7);
    expect(f.lines).toHaveLength(3);
    const syms = await api<{ path: string; line: number }[]>(
      `/api/reviews/${reviewId}/symbols?name=check&graph=head`,
    );
    expect(syms).toEqual([{ name: "check", path: "src/auth.ts", line: 8, kind: "function" }]);
    const commits = await api<{ subject: string }[]>(`/api/reviews/${reviewId}/commits`);
    expect(commits.map((c) => c.subject)).toEqual(["audit logins"]);
  });

  it("delivers an Ask-now question to the waiting agent and stores the reply", async () => {
    const waiting = cli(["wait", "--review", reviewId, "--timeout", "20"]);
    await new Promise((r) => setTimeout(r, 300));
    const th = (await post(`/api/reviews/${reviewId}/threads`, {
      kind: "question",
      mode: "ask",
      target: { type: "document", blockId: "x", quote: "audit" },
      body: "Why before check?",
    })) as { id: string };
    const ev = await waiting;
    expect(ev["wait"].reason).toBe("question");
    expect(ev["threads"][0].id).toBe(th.id);
    const replied = await cli([
      "threads",
      "reply",
      th.id,
      "--review",
      reviewId,
      "--body",
      "So failed attempts are logged too.",
    ]);
    expect(replied["thread"].messages).toBe(2);
    const got = await cli(["threads", "get", th.id, "--review", reviewId]);
    expect(got["messages"].map((m: Out) => m["role"])).toEqual(["reviewer", "agent"]);
    // the answered question is not reported again; a quiet timeout is a result, not a failure
    const again = await cli(["wait", "--review", reviewId, "--timeout", "1"]);
    expect(again["wait"].reason).toBe("timeout");
    expect(again["wait"].status).toBe("awaiting-review");
    expect(String(again["help"])).toContain("thurview wait");
  });

  it("holds review comments until submit, then blocks republish until they are resolved", async () => {
    const c = (await post(`/api/reviews/${reviewId}/threads`, {
      kind: "comment",
      mode: "review",
      target: { type: "file", path: "src/auth.ts", side: "head", line: 4, endLine: 5 },
      body: "Audit after check instead.",
    })) as { id: string; submitted: boolean };
    expect(c.submitted).toBe(false);
    const listed = await cli(["threads", "list", "--review", reviewId]);
    expect(listed["threads"].find((t: Out) => t["id"] === c.id).target).toBe("src/auth.ts:4-5");
    const idle = await cli(["wait", "--review", reviewId, "--timeout", "1"]);
    expect(idle["wait"].reason).toBe("timeout");
    await post(`/api/reviews/${reviewId}/submit`, {
      decision: "request-changes",
      body: "One change.",
    });
    const ev = await cli(["wait", "--review", reviewId, "--timeout", "5"]);
    expect(ev["wait"].reason).toBe("awaiting-agent-updates");
    expect(ev["threads"].map((t: Out) => t["id"])).toContain(c.id);
    const blocked = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(blocked["code"]).toBe("THREADS_OPEN");
    const resolved = await cli(["threads", "resolve", c.id, "--review", reviewId]);
    expect(resolved["openComments"]).toBe(0);
    const twice = await cli(["threads", "resolve", c.id, "--review", reviewId]);
    expect(String(twice["thread"])).toContain("no-op");
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(2);
    const revs = await api<{ revision: number }[]>(`/api/reviews/${reviewId}/revisions`);
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    const old = await api<{ revision: number; document: { title: string } }>(
      `/api/reviews/${reviewId}?revision=1`,
    );
    expect(old.revision).toBe(1);
  }, 20_000);

  it("approves and reports it to the agent", async () => {
    await post(`/api/reviews/${reviewId}/submit`, { decision: "approve" });
    const ev = await cli(["wait", "--review", reviewId, "--timeout", "5"]);
    expect(ev["wait"].reason).toBe("accepted");
    const info = await cli(["info", "--fields", "inSync,uuid"]);
    expect(info["reviews"][0].status).toBe("accepted");
    expect(info["reviews"][0].uuid).toBe(reviewId);
    expect(info["reviews"][0].inSync).toBe(true);
    const open = await cli(["threads", "list", "--review", reviewId, "--open"]);
    expect(String(open["count"])).toMatch(/^1 of 2 total, 0 need the agent/);
    expect(open["threads"][0].kind).toBe("question");
    await cli(["threads", "resolve", open["threads"][0].id, "--review", reviewId]);
    const none = await cli(["threads", "list", "--review", reviewId, "--open"]);
    expect(String(none["threads"])).toMatch(/^0 open threads/);
    const state = JSON.parse(await readFile(join(reviewDir, "review.json"), "utf8")) as {
      status: string;
    };
    expect(state.status).toBe("accepted");
  }, 20_000);

  it("closes a review without approving it and reports it to the agent", async () => {
    const ev = await cli(["scaffold"]);
    const id = ev["review"].uuid as string;
    expect(id).not.toBe(reviewId);
    const closed = (await post(`/api/reviews/${id}/submit`, {
      decision: "close",
      body: "Branch abandoned.",
    })) as { review: { status: string }; decisions: { decision: string }[] };
    expect(closed.review.status).toBe("closed");
    expect(closed.decisions.map((d) => d.decision)).toEqual(["close"]);
    const w = await cli(["wait", "--review", id, "--timeout", "5"]);
    expect(w["wait"].reason).toBe("closed");
    expect(w["wait"].decision).toBe("close: Branch abandoned.");
    const again = (await post(`/api/reviews/${id}/submit`, { decision: "approve" })) as {
      error?: string;
    };
    expect(again.error).toContain("closed");
    const blocked = await cli(["publish", "--review", id], { expectCode: 1 });
    expect(blocked["code"]).toBe("TERMINAL");
  }, 20_000);

  it("serves the UI shell and self-hosted fonts", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/review/${reviewId}`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("/app.js");
    const f = await fetch(`http://127.0.0.1:${server.port}/assets/fonts/inter-400.woff2`);
    expect(f.headers.get("content-type")).toBe("font/woff2");
    expect((await f.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  // ---- the explainer document kind ----
  // Its own block, and it never touches reviewId: the review path above must
  // keep passing exactly as it did before explainers existed.

  let explainerId = "";
  let explainerDir = "";

  it("pins an explainer to one commit and the scope the reader asked for", async () => {
    const out = await cli(["explain", "src"]);
    const e = out["explainer"];
    explainerId = e["id"];
    explainerDir = e["dir"];
    expect(e["kind"]).toBe("explainer");
    expect(e["scope"]).toBe("src/**");
    expect(e["title"]).toBe("src");
    expect(e["commit"]).toMatch(/^[0-9a-f]{40}$/);
    expect(out["scale"]["filesInScope"]).toBe(2);
    const info = await cli(["info", "--fields", "pins"]);
    const row = info["reviews"].find((r: Out) => r["id"] === explainerId);
    expect(row["kind"]).toBe("explainer");
    // one commit, not a range
    expect(row["pins"]).not.toContain("..");
  }, 20_000);

  it("refuses a scope that matches no file at the pinned commit", async () => {
    const out = await cli(["explain", "does/not/exist"], { expectCode: 2 });
    expect(out["code"]).toBe("VALIDATION_ERROR");
    expect(String(out["error"])).toContain("no file matches");
  });

  it("refuses the graph queries that compare two commits", async () => {
    for (const sub of ["impact", "interfaces"]) {
      const out = await cli(["graph", sub, "--review", explainerId], { expectCode: 2 });
      expect(String(out["error"])).toContain("compares two commits");
    }
    const arch = await cli(["graph", "architecture", "--review", explainerId]);
    expect(arch["scope"]).toBe("src/**");
    expect(arch["base"]).toBeUndefined();
    for (const c of arch["communities"])
      for (const f of c["files"]) expect(f.startsWith("src/")).toBe(true);
  }, 60_000);

  it("rejects an explainer that claims a change it cannot have", async () => {
    await writeFile(
      join(explainerDir, "data.yaml"),
      `anchors:\n  old: { title: old, peek: { file: src/auth.ts, from: 1, to: 2, graph: base } }\ninterfaces:\n  x: { name: --flag, change: added, capability: does a thing, anchor: old }\n`,
    );
    await writeFile(join(explainerDir, "review.md"), `# Explainer\n\nSee [old](anchor:old).\n`);
    const out = await cli(["publish", "--review", explainerId], { expectCode: 1 });
    const messages = out["diagnostics"].map((d: Out) => String(d["message"]));
    expect(messages.some((m: string) => m.includes("no interface delta"))).toBe(true);
    expect(messages.some((m: string) => m.includes("`graph: base` has no meaning"))).toBe(true);
  }, 60_000);

  it("rejects an explainer with no anchored claim", async () => {
    await writeFile(join(explainerDir, "data.yaml"), `anchors: {}\n`);
    await writeFile(join(explainerDir, "review.md"), `# Explainer\n\nTrust me.\n`);
    const out = await cli(["publish", "--review", explainerId], { expectCode: 1 });
    expect(
      out["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("needs at least one anchored claim"),
      ),
    ).toBe(true);
  }, 60_000);

  it("publishes an explainer and states what it did not examine", async () => {
    await writeFile(
      join(explainerDir, "data.yaml"),
      `anchors:\n  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }\n`,
    );
    await writeFile(
      join(explainerDir, "review.md"),
      `# How auth works\n\nA caller reaches [login()](anchor:login).\n`,
    );
    const out = await cli(["publish", "--review", explainerId]);
    expect(out["published"]["kind"]).toBe("explainer");
    // the interface delta is a claim about a change, so an explainer has none
    expect(out["published"]["interfaces"]).toBeUndefined();
    expect(String(out["published"]["coverage"])).toContain("2 files at");
    // src/audit.ts is neither anchored nor owned by a map node, and the document says so
    expect(out["notExamined"]["files"]).toBe(1);
    expect(out["notExamined"]["first"]).toContain("src/audit.ts");
    // no map, so nothing carries the breadth the prose left out, and it says so
    expect(String(out["warnings"])).toContain("no map");
  }, 60_000);

  it("counts a file a map node owns as placed, not as examined", async () => {
    await writeFile(
      join(explainerDir, "map.yaml"),
      `nodes:\n  - id: audit\n    kind: component\n    label: Audit log\n    files: ["src/audit.ts"]\nedges: []\n`,
    );
    const out = await cli(["publish", "--review", explainerId]);
    expect(out["notExamined"]["files"]).toBe(0);
    expect(String(out["published"]["coverage"])).toContain("1 placed on the map only");
  }, 60_000);

  it("serves an explainer with coverage and without a change", async () => {
    const d = await api<Out>(`/api/reviews/${explainerId}`);
    expect(d["review"]["kind"]).toBe("explainer");
    expect(d["review"]["binding"]["kind"]).toBe("codebase");
    expect(d["document"]["interfaces"]).toBe(null);
    expect(d["changes"]).toEqual([]);
    const cov = d["coverage"];
    expect(cov["scope"]).toBe("src/**");
    expect(cov["states"]).toEqual({ explained: 1, placed: 1, uncovered: 0 });
    expect(cov["uncovered"]).toEqual([]);
    expect(cov["verdict"]).toContain("not examined");
    // every count is re-derivable from the graph at the same commit
    expect(cov["clusters"].flatMap((c: Out) => c["explained"])).toContain("src/auth.ts");
  }, 20_000);

  it("tells a file it cannot read apart from one the file cap dropped", async () => {
    // notes.md is in no graph language, so it is absent from the structure. Saying
    // that about a file the repo-wide cap merely skipped would be a false claim,
    // and the two are counted separately.
    // the surface branch is where notes.md exists
    await cli(["explain", "**", "--update", "--commit", "surface", "--review", explainerId]);
    const out = await cli(["publish", "--review", explainerId]);
    expect(String(out["published"]["coverage"])).toContain(
      "outside the languages the code graph reads",
    );
    const d = await api<Out>(`/api/reviews/${explainerId}`);
    const cov = d["coverage"];
    expect(cov["scope"]).toBe("**");
    expect(cov["files"]["outsideGraph"]).toBe(1);
    expect(cov["files"]["capped"]).toBe(0);
    expect(cov["truncated"]).toBe(false);
    expect(cov["unclustered"]).toEqual([
      { file: "notes.md", state: "uncovered", reason: "outsideGraph" },
    ]);
    expect(cov["outsideGraph"]).toEqual([{ extension: "md", files: 1 }]);
  }, 60_000);

  it("answers --help per command without loading live state", async () => {
    const h = await cli(["threads", "--help"]);
    expect(h["command"]).toContain("thurview threads");
    expect(Object.keys(h["flags"])).toEqual(
      expect.arrayContaining(["--review <value>", "--body <value>"]),
    );
  });

  describe("a question the reader asks reaches an agent", () => {
    let qid = "";
    beforeEach(async () => {
      qid = (await cli(["scaffold"]))["review"].uuid as string;
    });
    afterEach(async () => {
      if (qid) await cli(["delete", "--review", qid]);
    });

    const ask = (body: string) =>
      post(`/api/reviews/${qid}/threads`, {
        kind: "question",
        mode: "ask",
        target: { type: "document", blockId: "b1" },
        body,
      }) as Promise<{ id: string }>;

    it("leaves a submitted Ask-now question open and needing the agent", async () => {
      const th = await ask("How is the memory ceiling defined?");
      const got = await cli(["threads", "get", th.id, "--review", qid]);
      expect(got["thread"].status).toBe("open");
      expect(got["thread"].needsAgent).toBe(true);
      const open = await cli(["threads", "list", "--review", qid, "--open"]);
      expect(open["threads"].map((t: Out) => t["id"])).toContain(th.id);
    });

    // The reader's own evidence: they resolved the thread, then wrote again.
    // A message nobody is assigned to is a message that reaches nobody.
    it("reopens a resolved thread when the reader writes in it again", async () => {
      const th = await ask("How is the memory ceiling defined?");
      await post(`/api/reviews/${qid}/threads/${th.id}/resolve`, {});
      await post(`/api/reviews/${qid}/threads/${th.id}/reply`, { body: "Hey" });
      const got = await cli(["threads", "get", th.id, "--review", qid]);
      expect(got["messages"].map((m: Out) => m["role"])).toEqual(["reviewer", "reviewer"]);
      expect(got["thread"].status).toBe("open");
      expect(got["thread"].needsAgent).toBe(true);
      const open = await cli(["threads", "list", "--review", qid, "--open"]);
      expect(open["threads"].map((t: Out) => t["id"])).toContain(th.id);
    });

    it("keeps an answered question resolvable by the reader", async () => {
      const th = await ask("How is the memory ceiling defined?");
      await cli(["threads", "reply", th.id, "--review", qid, "--body", "It is a heap cap."]);
      await post(`/api/reviews/${qid}/threads/${th.id}/resolve`, {});
      const got = await cli(["threads", "get", th.id, "--review", qid]);
      expect(got["thread"].status).toBe("resolved");
      expect(got["thread"].needsAgent).toBe(false);
    });

    it("reports whether an agent is listening, and never claims one that is not", async () => {
      const idle = await api<{ agent: { attached: boolean; lastSeen: string | null } }>(
        `/api/reviews/${qid}`,
      );
      expect(idle.agent).toEqual({ attached: false, lastSeen: null });
      const waiting = cli(["wait", "--review", qid, "--timeout", "4"]);
      let seen = { attached: false };
      for (let i = 0; i < 40 && !seen.attached; i++) {
        await new Promise((r) => setTimeout(r, 100));
        seen = (await api<{ agent: { attached: boolean } }>(`/api/reviews/${qid}`)).agent;
      }
      expect(seen.attached).toBe(true);
      expect((await waiting)["wait"].reason).toBe("timeout");
      const after = await api<{ agent: { attached: boolean } }>(`/api/reviews/${qid}`);
      expect(after.agent.attached).toBe(false);
    }, 20_000);
  });
});
