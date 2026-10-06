import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile, chmod, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
    // thurview's own theme: nothing for the agent to restyle, so no theme.yaml to fill in
    expect(ev["files"]?.theme).toBeUndefined();
    await expect(readFile(join(reviewDir, "theme.yaml"), "utf8")).rejects.toThrow(/ENOENT/);
    const home = await cli([]);
    expect(home["reviews"]).toHaveLength(1);
    expect(home["reviews"][0].status).toBe("draft");
  });

  it("publishes the untouched stub, so the reader can read the diff before the walkthrough", async () => {
    const ev = await cli(["scaffold", "--new"]);
    const id = ev["review"].uuid as string;
    expect(id).not.toBe(reviewId);
    // the comments-only theme.yaml an older scaffold wrote is not a theme to warn about
    await writeFile(join(ev["review"].dir, "theme.yaml"), "# Look of this review\n# name: acme\n");
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

  it("has no graph command: callers and tests are the agent's own search", async () => {
    const out = await cli(["graph", "impact", "--review", reviewId], { expectCode: 2 });
    expect(out["code"]).toBe("VALIDATION_ERROR");
  });

  it("names the interfaces a change adds, changes and removes, as the author declared them", async () => {
    const ev = await cli(["scaffold", "--base", "feature", "--head", "surface"]);
    const id = ev["review"].uuid as string;
    const dir = ev["review"].dir as string;
    await writeFile(
      join(dir, "data.yaml"),
      `anchors:
  oldAudit: { title: audit() before, peek: { file: src/audit.ts, from: 1, to: 3, graph: base } }
  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 3 } }
  record: { title: record(), peek: { file: src/audit.ts, from: 5, to: 7 } }
interfaces:
  record: { name: "record(user, ip)", change: added, capability: Records a login with the client ip., anchor: record }
  login: { name: "login(user, ip)", change: changed, capability: Callers must pass the client ip., anchor: login }
  audit: { name: audit(user), change: removed, capability: No longer exported; use record., anchor: oldAudit }
`,
    );
    await writeFile(
      join(dir, "review.md"),
      `# Record the client ip\n\n[login](anchor:login) passes the ip to [record](anchor:record); [audit](anchor:oldAudit) went private.\n`,
    );
    const out = await cli(["publish", "--review", id]);
    expect(out["published"].interfaces).toBe("1 removed, 1 changed, 1 added.");
    const p = await api<Out>(`/api/reviews/${id}`);
    // removed first: it is the entry a reviewer must not miss
    expect(
      (p["document"]["interfaces"]["entries"] as Out[]).map((e) => `${e["change"]} ${e["name"]}`),
    ).toEqual(["removed audit(user)", "changed login(user, ip)", "added record(user, ip)"]);
    await cli(["delete", "--review", id]);
  }, 30_000);

  it("says plainly when a change declares no interface", async () => {
    const ev = await cli(["scaffold", "--base", "surface", "--head", "refactor"]);
    const id = ev["review"].uuid as string;
    const out = await cli(["publish", "--review", id]);
    expect(out["published"].interfaces).toBe("No interface change declared.");
    await cli(["delete", "--review", id]);
  }, 30_000);

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

  // A user flow used to have no component at all: a ```mermaid fence fell
  // through to markdown-it and reached the reader as its own source text, with
  // publish reporting nothing. Both halves are asserted here - the foreign
  // fence is refused, and a flow that cannot be drawn is refused saying why.
  it("refuses a foreign diagram fence and a flow it cannot draw", async () => {
    expect(reviewDir).toBeTruthy();
    await writeFile(
      join(reviewDir, "data.yaml"),
      `actors:
  caller: { label: Caller }
anchors:
  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }
`,
    );
    await writeFile(
      join(reviewDir, "review.md"),
      `# Title

\`\`\`mermaid
flowchart TD
  A[Visitor] --> B{Signed in?}
\`\`\`
`,
    );
    const foreign = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(foreign["code"]).toBe("PUBLISH_FAILED");
    expect(
      foreign["diagnostics"].some(
        (d: Out) =>
          String(d["message"]).includes("mermaid is not rendered") &&
          String(d["message"]).includes("`flow`"),
      ),
    ).toBe(true);

    const flow = (body: string) =>
      writeFile(join(reviewDir, "review.md"), `# Title\n\n\`\`\`flow\n${body}\`\`\`\n`);
    const refusal = async (body: string, want: string) => {
      await flow(body);
      const out = await cli(["publish", "--review", reviewId], { expectCode: 1 });
      expect(
        out["diagnostics"].map((d: Out) => String(d["message"])).join("\n"),
        `flow:\n${body}`,
      ).toContain(want);
    };

    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: gone }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'step "land" continues to unknown step "gone"',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: land }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'step "land" follows itself',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'step "post" is unreachable from "land", the first step',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: post }
  - { id: post, label: Credentials posted, actor: caller }
`,
      "no step carries an anchor",
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, next: post }
  - { id: post, label: Credentials posted, anchor: login }
`,
      "each step needs an anchor or an actor",
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: post, when: [{ case: a, to: post }, { case: b, to: post }] }
  - { id: post, label: Credentials posted, anchor: login }
`,
      "a step continues with `next` or branches with `when`, not both",
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, when: [{ case: only, to: post }] }
  - { id: post, label: Credentials posted, anchor: login }
`,
      "a branch has two or more cases; one case is `next`",
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: post }
  - { id: land, label: Again, anchor: login }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'duplicate step "land"',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: ghost, next: post }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'step land references unknown actor "ghost"',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller, next: post }
  - { id: post, label: Credentials posted, anchor: nowhere }
`,
      'step post references unknown anchor "nowhere"',
    );
    await refusal(
      `label: Sign in
steps:
  - { id: land, label: Caller arrives, actor: caller,
      when: [{ case: first, to: post }, { case: again, to: post }] }
  - { id: post, label: Credentials posted, anchor: login }
`,
      'step "land" branches to "post" twice',
    );
  }, 40_000);

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
    name: audit(user)
    change: added
    anchor: audit
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

The refusal points at \`text\`, so quoting the source that way has to publish:

\`\`\`text
flowchart TD
  A[Visitor] --> B{Signed in?}
\`\`\`

\`\`\`flow
label: A login attempt
steps:
  - { id: arrive,  label: Caller calls login,   actor: caller, next: recorded }
  - { id: recorded, label: Attempt recorded,    anchor: auditCall, next: decide }
  - { id: decide,  label: User non-empty?,      anchor: check,
      when: [{ case: accepted, to: allowed }, { case: rejected, to: refused }] }
  - { id: allowed, label: login() answers true, anchor: login }
  - { id: refused, label: Caller tries again,   actor: caller, next: arrive }
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
    // a symbol entry named a row a code graph derived, and there is none; an
    // entry whose anchor proves nothing is rejected rather than published
    const data = await readFile(join(reviewDir, "data.yaml"), "utf8");
    await writeFile(
      join(reviewDir, "data.yaml"),
      data.replace(
        "name: audit(user)\n    change: added\n    anchor: audit",
        "symbol: src/audit.ts:audit",
      ),
    );
    const stale = await cli(["publish", "--review", reviewId], { expectCode: 1 });
    expect(stale["diagnostics"].some((d: Out) => String(d["message"]).includes("symbol"))).toBe(
      true,
    );
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
    // a theme.yaml left by an older thurview is ignored, and publish says so
    await writeFile(
      join(reviewDir, "theme.yaml"),
      `name: demo-light\nmode: light\ncolors: { bg: "#000000" }\n`,
    );
    const out = await cli(["publish", "--review", reviewId]);
    expect(out["published"].rev).toBe(1);
    expect(out["published"].map).toBe(true);
    expect(out["published"].theme).toBeUndefined();
    expect(out["published"].interfaces).toBe("2 added.");
    expect(out["diagnostics"]).toHaveLength(1);
    expect(out["diagnostics"][0].level).toBe("warning");
    expect(out["diagnostics"][0].message).toContain("no longer restyles");
  }, 20_000);

  it("serves the compiled document, diffs, files, symbols and map", async () => {
    const p = await api<{
      review: { status: string; title: string };
      theme?: unknown;
      document: {
        blocks: { type: string }[];
        anchors: Record<string, { peek?: { lines: string[] } }>;
        interfaces: {
          entries: { change: string; name: string; capability?: string; anchor?: string }[];
          verdict: string;
        } | null;
      };
      map: { diff: { added: string[]; changed: string[] }; filesByNode: Record<string, string[]> };
      changes: { path: string }[];
    }>(`/api/reviews/${reviewId}`);
    const ifaces = p.document.interfaces!;
    expect(ifaces.entries.map((e) => `${e.change} ${e.name}`)).toEqual([
      "added audit(user)",
      "added auth.login --strict",
    ]);
    expect(ifaces.entries[0]!.capability).toContain("record a login attempt");
    expect(ifaces.entries[1]!.anchor).toBe("auditCall");
    expect(ifaces.verdict).toBe("2 added.");
    expect(p.review.status).toBe("awaiting-review");
    expect(p.theme).toBeUndefined();
    // a revision sealed under the old dark palette is read back in the reader's palette
    const sealed = join(home, "reviews", reviewId, "revisions", "1", "document.json");
    const original = await readFile(sealed, "utf8");
    const doc = JSON.parse(original);
    doc.anchors.login.peek.lines = doc.anchors.login.peek.lines.map(
      (l: string) => `<span style="color:#E0E0E0">${l.replace(/<[^>]+>/g, "")}</span>`,
    );
    // and one whose file can no longer be read keeps its text, but not a colour
    // that may be unreadable on the reader's ground
    doc.anchors.check.peek.file = "src/gone.ts";
    doc.anchors.check.peek.lines = ['<span style="color:#0A3069;font-style:italic">x</span>'];
    await writeFile(sealed, JSON.stringify(doc));
    const old = await api<{ document: { anchors: Record<string, { peek: { lines: string[] } }> } }>(
      `/api/reviews/${reviewId}`,
    );
    await writeFile(sealed, original);
    const oldLines = old.document.anchors["login"]!.peek.lines.join("");
    expect(oldLines).not.toMatch(/#E0E0E0/i);
    expect(oldLines).toMatch(/color:var\(--code-keyword\)/);
    const gone = old.document.anchors["check"]!.peek.lines.join("");
    expect(gone).toContain(">x</span>");
    expect(gone).not.toMatch(/#0A3069/i);
    expect(p.review.title).toBe("Audit every login");
    const types = p.document.blocks.map((b) => b.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "heading",
        "html",
        "sequence",
        "callstack",
        "database",
        "flow",
        "peek",
      ]),
    );
    // The four components that predate `flow` are pinned here, so adding a
    // fifth cannot quietly move what any of them renders.
    const block = <T>(type: string) => p.document.blocks.find((b) => b.type === type) as T;
    const seq = block<{ label: string; actors: { id: string }[]; messages: Out[] }>("sequence");
    expect(seq.label).toBe("Login");
    expect(seq.actors.map((a) => a.id)).toEqual(["caller", "auth", "log"]);
    expect(
      seq.messages.map((m) => `${m["from"]}->${m["to"]} ${m["anchor"] ?? m["code"].text}`),
    ).toEqual(["caller->auth login", "auth->log auditCall", "auth->auth return check(user);"]);
    const stack = block<{ title: string; rows: Out[] }>("callstack");
    expect(stack.title).toBe("Login path");
    expect(stack.rows.map((r) => `${r["kind"]} ${r["anchor"]}`)).toEqual([
      "context login",
      "add audit",
      "context check",
    ]);
    const db = block<{ title: string; stores: string[]; usecases: Out[] }>("database");
    expect(db.title).toBe("Audit storage");
    expect(db.stores).toEqual(["logdb"]);
    expect(db.usecases.map((u) => u["id"])).toEqual(["write"]);
    expect(block<{ anchor: string }>("peek").anchor).toBe("check");
    // The escape hatch the mermaid refusal names: re-fenced as `text` the same
    // source publishes and arrives as a code block, not as a component.
    expect(
      p.document.blocks.some(
        (b) => b.type === "html" && (b as { html: string }).html.includes("flowchart TD"),
      ),
    ).toBe(true);
    // The flow itself: the steps as declared, the decision marked, and the
    // branch and retry edges - including the one that goes back up.
    const fl = block<{
      label: string;
      steps: { id: string; label: string; actor?: string; anchor?: string; decision: boolean }[];
      edges: { from: string; to: string; case?: string }[];
    }>("flow");
    expect(fl.label).toBe("A login attempt");
    expect(fl.steps.map((s) => s.id)).toEqual([
      "arrive",
      "recorded",
      "decide",
      "allowed",
      "refused",
    ]);
    expect(fl.steps.filter((s) => s.decision).map((s) => s.id)).toEqual(["decide"]);
    expect(fl.steps.find((s) => s.id === "arrive")).toEqual({
      id: "arrive",
      label: "Caller calls login",
      actor: "caller",
      decision: false,
    });
    expect(fl.edges.map((e) => `${e.from} ${e.case ?? ""}> ${e.to}`)).toEqual([
      "arrive > recorded",
      "recorded > decide",
      "decide accepted> allowed",
      "decide rejected> refused",
      "refused > arrive",
    ]);
    expect(p.document.anchors["login"]!.peek!.lines).toHaveLength(4);
    expect(p.map.diff.added).toEqual(["app.audit"]);
    expect(p.map.diff.changed).toEqual(["app.auth"]);
    expect(p.map.filesByNode["app.auth"]).toEqual(["src/auth.ts"]);
    expect(p.changes.map((c) => c.path).sort()).toEqual(["src/audit.ts", "src/auth.ts"]);

    const d = await api<{ hunks: { rows: { type: string; html: string }[] }[] }>(
      `/api/reviews/${reviewId}/diff?path=src/auth.ts`,
    );
    expect(d.hunks[0]!.rows.filter((r) => r.type === "add")).toHaveLength(3);
    expect(d.hunks[0]!.rows.map((r) => r.html).join("")).toMatch(/color:var\(--code-keyword\)/);
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

  // ---- the security dimension ----
  // Its own review, so the revisions the flow above publishes stay exactly what
  // they were: whether a change crosses a trust boundary is a fact about the
  // change, and the reader is shown it either way.

  describe("where a change crosses a trust boundary", () => {
    let secId = "";
    let secDir = "";

    beforeAll(async () => {
      const ev = await cli(["scaffold", "--new"]);
      secId = ev["review"].uuid as string;
      secDir = ev["review"].dir as string;
      await writeFile(
        join(secDir, "review.md"),
        `# Audit every login\n\nThe change logs every attempt.\n`,
      );
    }, 20_000);

    afterAll(async () => {
      if (secId) await cli(["delete", "--review", secId]);
    });

    it("says it has not assessed the change, then says the change crosses nothing", async () => {
      // silence and "nothing here" are different claims, so the document makes
      // both of them out loud and never lets the first pass for the second
      await writeFile(join(secDir, "data.yaml"), `anchors: {}\n`);
      const quiet = await cli(["publish", "--review", secId]);
      expect(String(quiet["published"]["security"])).toContain("Not assessed");

      await writeFile(join(secDir, "data.yaml"), `anchors: {}\nsecurity: none\n`);
      const none = await cli(["publish", "--review", secId]);
      expect(String(none["published"]["security"])).toBe("No trust boundary crossed.");
      expect(none["diagnostics"]).toBeUndefined();
      const d = await api<Out>(`/api/reviews/${secId}`);
      expect(d["document"]["security"]["state"]).toBe("none");
      expect(d["document"]["security"]["crossings"]).toEqual([]);
    }, 30_000);

    it("surfaces each crossing anchored to the code, without a section in the prose", async () => {
      await writeFile(
        join(secDir, "data.yaml"),
        `anchors:\n  logLine: { title: the audit log line, peek: { file: src/audit.ts, from: 2, to: 2 } }\nsecurity:\n  - boundary: audit() writes the user id into the process log.\n    anchor: logLine\n`,
      );
      const out = await cli(["publish", "--review", secId]);
      expect(String(out["published"]["security"])).toBe("1 trust boundary crossed.");
      // the crossing is what marks the anchor used, so it needs no prose link
      expect(out["diagnostics"]).toBeUndefined();
      const d = await api<Out>(`/api/reviews/${secId}`);
      const sec = d["document"]["security"];
      expect(sec["state"]).toBe("crossings");
      expect(sec["crossings"]).toEqual([
        { boundary: "audit() writes the user id into the process log.", anchor: "logLine" },
      ]);
      // anchored like the rest of the document: the reader opens the range itself
      expect(d["document"]["anchors"]["logLine"]["peek"]["lines"]).toHaveLength(1);
      // and it adds nothing to the prose the agent wrote
      expect(d["document"]["toc"]).toEqual([]);
    }, 30_000);

    it("serves a revision sealed before the dimension existed without a hole in it", async () => {
      // revisions are read back verbatim, so an older thurview's document.json
      // has no `security` at all. The reader opens those from the revision
      // picker, and `undefined` is not the absence the browser is written for.
      await writeFile(join(secDir, "data.yaml"), `anchors: {}\nsecurity: none\n`);
      const sealed = await cli(["publish", "--review", secId]);
      const rev = String(sealed["published"]["rev"]);
      const doc = join(home, "reviews", secId, "revisions", rev, "document.json");
      const old = JSON.parse(await readFile(doc, "utf8"));
      delete old.security;
      await writeFile(doc, JSON.stringify(old));
      const d = await api<Out>(`/api/reviews/${secId}?revision=${rev}`);
      expect(d["document"]["security"]).toBe(null);
    }, 20_000);

    it("blames the crossing it cannot read, not the anchors it can", async () => {
      // a malformed `security` must not take the rest of data.yaml down with
      // it: an author sent to fix two anchors that are correct stops reading
      // diagnostics, which is worse than the one that was right
      await writeFile(
        join(secDir, "data.yaml"),
        `anchors:\n  logLine: { title: the audit log line, peek: { file: src/audit.ts, from: 2, to: 2 } }\nsecurity:\n  - boundary: audit() writes the user id into the process log.\n`,
      );
      await writeFile(
        join(secDir, "review.md"),
        `# Audit every login\n\nThe [audit line](anchor:logLine) is new.\n`,
      );
      const out = await cli(["publish", "--review", secId], { expectCode: 1 });
      const messages = out["diagnostics"].map((d: Out) => String(d["message"]));
      expect(messages.some((m: string) => m.includes("security crossing 1: anchor:"))).toBe(true);
      expect(messages.some((m: string) => m.includes('unknown anchor "logLine"'))).toBe(false);
      expect(messages.some((m: string) => m.includes("anchor link to unknown anchor"))).toBe(false);

      // and the other way round: a crossing that reads perfectly is not blamed
      // for a mistake somewhere else in data.yaml. Nothing in the file parsed,
      // so the anchors are not known to be missing - they are not known at all.
      // The prose links none of them, so the crossing is the only thing that
      // could name one
      await writeFile(
        join(secDir, "review.md"),
        `# Audit every login\n\nThe change logs every attempt.\n`,
      );
      await writeFile(
        join(secDir, "data.yaml"),
        `anchors:\n  logLine: { title: the audit log line, peek: { file: src/audit.ts, from: 2, to: 2 } }\nstores:\n  db: { kind: relational, label: DB }\nsecurity:\n  - { boundary: audit() logs the user id., anchor: logLine }\n`,
      );
      const elsewhere = await cli(["publish", "--review", secId], { expectCode: 1 });
      const other = elsewhere["diagnostics"].map((d: Out) => String(d["message"]));
      expect(other.some((m: string) => m.includes("relational stores need tables"))).toBe(true);
      expect(other.some((m: string) => m.includes('unknown anchor "logLine"'))).toBe(false);

      // one bad entry does not un-use the anchors the good entries name: the
      // crossing is what marks them used, and a warning saying otherwise is the
      // same false blame one warning level down
      await writeFile(
        join(secDir, "data.yaml"),
        `anchors:\n  one: { title: one, peek: { file: src/audit.ts, from: 1, to: 1 } }\n  two: { title: two, peek: { file: src/audit.ts, from: 2, to: 2 } }\nsecurity:\n  - { boundary: the first, anchor: one }\n  - { boundary: the second, anchor: two }\n  - { boundary: the third }\n`,
      );
      const partial = await cli(["publish", "--review", secId], { expectCode: 1 });
      const rows = partial["diagnostics"].map((d: Out) => String(d["message"]));
      expect(rows.some((m: string) => m.includes("security crossing 3"))).toBe(true);
      expect(rows.some((m: string) => m.includes("defined but never used"))).toBe(false);

      // and the shape of `security` is read from the raw file, so a mistake in
      // it is reported next to a mistake elsewhere rather than one publish later
      await writeFile(
        join(secDir, "data.yaml"),
        `anchors: {}\nstores:\n  db: { kind: relational, label: DB }\nsecurity:\n  - { boundary: the first }\n`,
      );
      const both = await cli(["publish", "--review", secId], { expectCode: 1 });
      const two = both["diagnostics"].map((d: Out) => String(d["message"]));
      expect(two.some((m: string) => m.includes("relational stores need tables"))).toBe(true);
      expect(two.some((m: string) => m.includes("security crossing 1"))).toBe(true);

      // a value that is neither of the two words nor a list says so in its own
      // right, rather than as "Invalid input" over a discarded data.yaml
      await writeFile(join(secDir, "data.yaml"), `anchors: {}\nsecurity: maybe\n`);
      await writeFile(join(secDir, "review.md"), `# Audit every login\n\nNothing yet.\n`);
      const word = await cli(["publish", "--review", secId], { expectCode: 1 });
      expect(
        word["diagnostics"].some((d: Out) => String(d["message"]).includes("write `none`")),
      ).toBe(true);
    }, 30_000);

    it("refuses a crossing whose anchor proves nothing", async () => {
      const cases: [string, string][] = [
        [`anchors: {}\nsecurity:\n  - { boundary: x, anchor: nope }\n`, 'unknown anchor "nope"'],
        [
          `anchors:\n  bare: { title: bare }\nsecurity:\n  - { boundary: x, anchor: bare }\n`,
          'anchor "bare" has no peek',
        ],
        [
          `anchors:\n  old: { title: old, peek: { file: src/auth.ts, from: 1, to: 2, graph: base } }\nsecurity:\n  - { boundary: x, anchor: old }\n`,
          "takes a head anchor",
        ],
        [`anchors: {}\nsecurity: []\n`, "write `none`"],
      ];
      for (const [data, message] of cases) {
        await writeFile(join(secDir, "data.yaml"), data);
        const out = await cli(["publish", "--review", secId], { expectCode: 1 });
        expect(out["code"]).toBe("PUBLISH_FAILED");
        expect(
          out["diagnostics"].some((d: Out) => String(d["message"]).includes(message)),
          `${data} should be refused with ${message}`,
        ).toBe(true);
      }
    }, 60_000);
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

  it("rejects an explainer that states a trust boundary its kind cannot cross", async () => {
    await writeFile(
      join(explainerDir, "data.yaml"),
      `anchors:\n  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }\nsecurity: none\n`,
    );
    await writeFile(join(explainerDir, "review.md"), `# Explainer\n\nSee [login](anchor:login).\n`);
    const out = await cli(["publish", "--review", explainerId], { expectCode: 1 });
    expect(
      out["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("security is what a change crosses"),
      ),
    ).toBe(true);
    // the key itself is what the kind cannot carry, so its default value is no
    // more publishable than any other: the documents say "no such key", and a
    // check on the value would make that sentence false
    await writeFile(
      join(explainerDir, "data.yaml"),
      `anchors:\n  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }\nsecurity: pending\n`,
    );
    const pending = await cli(["publish", "--review", explainerId], { expectCode: 1 });
    expect(
      pending["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("security is what a change crosses"),
      ),
    ).toBe(true);
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

  it("counts a file only a recorded search matched as searched, re-run at the pinned commit", async () => {
    const anchors = `anchors:\n  login: { title: login(), peek: { file: src/auth.ts, from: 3, to: 6 } }\n`;
    await writeFile(
      join(explainerDir, "data.yaml"),
      `${anchors}searches:\n  logs: { pattern: '(', why: what writes to the console }\n`,
    );
    const bad = await cli(["publish", "--review", explainerId], { expectCode: 1 });
    expect(
      bad["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("search logs: git grep refused"),
      ),
    ).toBe(true);
    await writeFile(
      join(explainerDir, "data.yaml"),
      `${anchors}searches:\n  logs: { pattern: 'console\\.log', why: what writes to the console }\n  tests: { pattern: 'describe\\(', why: what tests auth }\n`,
    );
    const out = await cli(["publish", "--review", explainerId]);
    expect(out["notExamined"]["files"]).toBe(0);
    expect(String(out["published"]["coverage"])).toContain("1 matched by a recorded search only");
    const cov = (await api<Out>(`/api/reviews/${explainerId}`))["coverage"];
    expect(cov["searches"]).toEqual([
      expect.objectContaining({ key: "logs", hits: 1, files: ["src/audit.ts"] }),
      // a search that found nothing is stated, not dropped: a zero is a finding
      expect.objectContaining({ key: "tests", hits: 0, files: [] }),
    ]);
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
    expect(cov["states"]).toEqual({ explained: 1, placed: 1, searched: 0, uncovered: 0 });
    expect(cov["uncovered"]).toEqual([]);
    expect(cov["verdict"]).toContain("not examined");
    // every count is re-derivable from the files at the same commit
    expect(cov["clusters"].flatMap((c: Out) => c["explained"])).toContain("src/auth.ts");
  }, 20_000);

  it("accounts for a file in any language, grouped by the directory it sits in", async () => {
    // the surface branch is where notes.md exists; nothing parses it, and
    // nothing has to, for it to be counted as not examined
    await cli(["explain", "**", "--update", "--commit", "surface", "--review", explainerId]);
    const out = await cli(["publish", "--review", explainerId]);
    expect(out["notExamined"]["first"]).toEqual(["notes.md"]);
    const cov = (await api<Out>(`/api/reviews/${explainerId}`))["coverage"];
    expect(cov["scope"]).toBe("**");
    expect(cov["files"]["total"]).toBe(3);
    expect((cov["clusters"] as Out[]).map((c) => [c["label"], c["files"]])).toEqual([
      ["src", 2],
      [".", 1],
    ]);
  }, 60_000);

  // ---- the design document kind ----
  // Its own block, and it never touches reviewId or explainerId: a design is a
  // third kind beside them, not a change to either.

  let designId = "";
  let designDir = "";

  const designData = (extra = "") =>
    `anchors:\n  login: { title: login() today, peek: { file: src/auth.ts, from: 3, to: 6 } }\ninterfaces:\n  strict:\n    name: auth.login --strict\n    change: added\n    capability: Rejects an empty user instead of answering false.\n    anchor: login\n${extra}`;
  const designMd = `# Reject empty users at the door\n\nToday [login()](anchor:login) answers false for an empty user.\n`;

  it("pins a design to one commit and the scope the reader asked for", async () => {
    const out = await cli(["design", "src"]);
    const d = out["design"];
    designId = d["id"];
    designDir = d["dir"];
    expect(d["kind"]).toBe("design");
    expect(d["scope"]).toBe("src/**");
    expect(d["commit"]).toMatch(/^[0-9a-f]{40}$/);
    const info = await cli(["info", "--fields", "pins"]);
    const row = info["reviews"].find((r: Out) => r["id"] === designId);
    expect(row["kind"]).toBe("design");
    // one commit, not a range: a design argues from the code as it stands
    expect(row["pins"]).not.toContain("..");
  }, 20_000);

  it("rejects a design whose anchor points at code that is not there", async () => {
    // `graph: base` claims a diff, and a symbol entry a derived row. A design
    // has one commit and proposes what is not written yet.
    await writeFile(
      join(designDir, "data.yaml"),
      `anchors:\n  old: { title: old, peek: { file: src/auth.ts, from: 1, to: 2, graph: base } }\ninterfaces:\n  audited:\n    symbol: src/audit.ts:audit\n    capability: does a thing\n`,
    );
    await writeFile(join(designDir, "review.md"), `# Design\n\nSee [old](anchor:old).\n`);
    const out = await cli(["publish", "--review", designId], { expectCode: 1 });
    const messages = out["diagnostics"].map((d: Out) => String(d["message"]));
    expect(messages.some((m: string) => m.includes("`graph: base` has no meaning"))).toBe(true);
    expect(messages.some((m: string) => m.includes("proposes an interface"))).toBe(true);
  }, 60_000);

  it("rejects a design that proposes nothing", async () => {
    await writeFile(
      join(designDir, "data.yaml"),
      `anchors:\n  login: { title: login() today, peek: { file: src/auth.ts, from: 3, to: 6 } }\ninterfaces: {}\n`,
    );
    await writeFile(join(designDir, "review.md"), designMd);
    const out = await cli(["publish", "--review", designId], { expectCode: 1 });
    expect(
      out["diagnostics"].some((d: Out) => String(d["message"]).includes("proposes nothing")),
    ).toBe(true);
  }, 60_000);

  it("rejects a design that states a trust boundary its kind cannot cross", async () => {
    await writeFile(join(designDir, "data.yaml"), designData("security: none\n"));
    await writeFile(join(designDir, "review.md"), designMd);
    const out = await cli(["publish", "--review", designId], { expectCode: 1 });
    expect(
      out["diagnostics"].some((d: Out) =>
        String(d["message"]).includes("security is what a change crosses"),
      ),
    ).toBe(true);
  }, 60_000);

  it("publishes a design and states what it proposes", async () => {
    await writeFile(join(designDir, "data.yaml"), designData());
    await writeFile(join(designDir, "review.md"), designMd);
    const out = await cli(["publish", "--review", designId]);
    expect(out["published"]["kind"]).toBe("design");
    expect(String(out["published"]["proposes"])).toBe("Proposed: 1 added.");
    // a design is not a change, so it has neither an interface delta nor coverage
    expect(out["published"]["interfaces"]).toBeUndefined();
    expect(out["published"]["coverage"]).toBeUndefined();
  }, 60_000);

  it("warns about a dead glob on today's structure and not on a proposed part", async () => {
    await writeFile(
      join(designDir, "map.yaml"),
      `nodes:\n  - { id: auth, kind: component, label: Auth, files: ["src/auth.ts"] }\n  - { id: policy, kind: component, label: Policy engine, files: ["src/policy.ts"] }\nedges:\n  - { from: auth, to: policy, label: asks }\nbase:\n  nodes:\n    - { id: auth, kind: component, label: Auth, files: ["src/auth.ts"] }\n    - { id: legacy, kind: component, label: Legacy, files: ["src/legacy/**"] }\n  edges: []\n`,
    );
    const out = await cli(["publish", "--review", designId]);
    expect(out["published"]["map"]).toBe(true);
    const messages = (out["diagnostics"] ?? []).map((d: Out) => String(d["message"]));
    // src/legacy/** is a claim about the code today, and it is wrong
    expect(messages.some((m: string) => m.includes("src/legacy/**"))).toBe(true);
    // src/policy.ts is the part the design proposes; it owns no file yet by design
    expect(messages.some((m: string) => m.includes("src/policy.ts"))).toBe(false);
  }, 60_000);

  it("serves a design with its proposals, no diff and no coverage", async () => {
    const d = await api<Out>(`/api/reviews/${designId}`);
    expect(d["review"]["kind"]).toBe("design");
    expect(d["changes"]).toEqual([]);
    expect(d["coverage"]).toBe(null);
    const proposals = d["document"]["interfaces"];
    expect(proposals["verdict"]).toBe("Proposed: 1 added.");
    expect(proposals["entries"]).toHaveLength(1);
    const e = proposals["entries"][0];
    expect(e["change"]).toBe("added");
    expect(e["name"]).toBe("auth.login --strict");
    expect(e["anchor"]).toBe("login");
    // the site: real code at the pinned commit, which is what the reader opens
    expect(e["file"]).toBe("src/auth.ts");
    expect(e["line"]).toBe(3);
    expect(d["map"]["diff"]["added"]).toEqual(["policy"]);
    expect(d["map"]["diff"]["removed"]).toEqual(["legacy"]);
  }, 20_000);

  it("takes a comment on a design and the reader's approval of it", async () => {
    // The whole point of the kind: a plan read, annotated and decided on in the
    // surface a review uses, through the same endpoints.
    const th = (await post(`/api/reviews/${designId}/threads`, {
      kind: "comment",
      mode: "review",
      target: { type: "document", blockId: "interface-delta" },
      body: "Does --strict change the default, or only add a flag?",
    })) as { id: string };
    await post(`/api/reviews/${designId}/submit`, {
      decision: "approve",
      body: "Build it.",
    });
    const after = await api<Out>(`/api/reviews/${designId}`);
    expect(after["review"]["status"]).toBe("accepted");
    expect(after["decisions"].at(-1)["decision"]).toBe("approve");
    expect(after["threads"].find((t: Out) => t["id"] === th.id)["submitted"]).toBe(true);
  }, 20_000);

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

    // The reader's own evidence: the page said nobody was listening while the
    // agent that `wait` had just handed their question to was answering it.
    it("keeps an agent listening while it answers the question wait handed it", async () => {
      const waiting = cli(["wait", "--review", qid, "--timeout", "10"]);
      let seen = { attached: false };
      for (let i = 0; i < 40 && !seen.attached; i++) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      }
      expect(seen.attached).toBe(true);
      const th = await ask("How is the memory ceiling defined?");
      expect((await waiting)["wait"].reason).toBe("question");
      const answering = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      expect(answering.attached).toBe(true);
      await cli(["threads", "reply", th.id, "--review", qid, "--body", "It is a heap cap."]);
      const replied = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      expect(replied.attached).toBe(true);
    }, 20_000);

    // A `wait` with something to report returns before its first heartbeat is
    // written; that write must not land after the removal and outlive it.
    it("leaves no listener behind a wait that returns at once", async () => {
      await post(`/api/reviews/${qid}/submit`, { decision: "close", body: "" });
      expect((await cli(["wait", "--review", qid, "--timeout", "10"]))["wait"].reason).toBe(
        "closed",
      );
      const after = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      expect(after.attached).toBe(false);
    }, 20_000);

    // An open tab polls this endpoint instead of relying on the reviewDir SSE
    // watch, which the heartbeat deliberately never fires. It must answer with
    // the live fact, not a value cached from the last full payload fetch.
    it("answers a standalone presence check without a full payload fetch", async () => {
      const idle = await api<{ attached: boolean; lastSeen: string | null }>(
        `/api/reviews/${qid}/presence`,
      );
      expect(idle).toEqual({ attached: false, lastSeen: null });
      const waiting = cli(["wait", "--review", qid, "--timeout", "4"]);
      let seen = { attached: false };
      for (let i = 0; i < 40 && !seen.attached; i++) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      }
      expect(seen.attached).toBe(true);
      await waiting;
      const after = await api<{ attached: boolean }>(`/api/reviews/${qid}/presence`);
      expect(after.attached).toBe(false);
    }, 20_000);
  });

  // The other half of the loop: the reader submitted, and these threads have to
  // become the file `forge submit` takes without carrying the wrong ones over.
  describe("the pass a submitted review becomes", () => {
    let pid = "";
    beforeEach(async () => {
      pid = (await cli(["scaffold"]))["review"].uuid as string;
    }, 30_000);
    afterEach(async () => {
      if (pid) await cli(["delete", "--review", pid]);
    }, 30_000);

    const thread = (kind: "comment" | "question", target: unknown, body: string) =>
      post(`/api/reviews/${pid}/threads`, {
        kind,
        mode: kind === "question" ? "ask" : "review",
        target,
        body,
      }) as Promise<{ id: string }>;
    const at = (line: number, endLine?: number, side: "head" | "base" = "head") => ({
      type: "file",
      path: "src/auth.ts",
      side,
      line,
      ...(endLine ? { endLine } : {}),
    });
    const submit = (decision: string, body?: string) =>
      post(`/api/reviews/${pid}/submit`, { decision, ...(body ? { body } : {}) });
    const passFile = async (out: Out) =>
      JSON.parse(await readFile(String(out["pass"].file), "utf8")) as {
        verdict: string;
        body: string;
        comments: { path: string; line: number; startLine?: number; side?: string; body: string }[];
      };

    it("anchors file threads inline and takes the verdict from the decision", async () => {
      await thread("comment", at(4, 5), "Audit after check instead.");
      await thread("comment", at(2, undefined, "base"), "This line was the contract.");
      await submit("request-changes", "One change.");

      const out = await cli(["forge", "pass", "--review", pid]);
      expect(out["pass"].verdict).toBe("request-changes");
      expect(out["pass"].decision).toBe("request-changes");
      expect(out["pass"].inline).toBe(2);
      expect(out["pass"].summary).toBe(0);
      expect(out["pass"].skipped).toBe(0);
      expect(out["comments"].map((c: Out) => c["at"])).toEqual([
        "src/auth.ts:4-5",
        "src/auth.ts:2",
      ]);
      expect(String(out["summary"])).toMatch(/^0 /);

      const file = await passFile(out);
      // Outside reviewDir, which the server watches: a write there reloads the reader's page.
      expect(String(out["pass"].file)).toBe(join(home, "passes", `${pid}.json`));
      expect(file.verdict).toBe("request-changes");
      expect(file.body).toContain("One change.");
      expect(file.comments).toEqual([
        {
          path: "src/auth.ts",
          line: 5,
          startLine: 4,
          side: "head",
          body: "Audit after check instead.",
        },
        { path: "src/auth.ts", line: 2, side: "base", body: "This line was the contract." },
      ]);
    }, 30_000);

    it("leaves questions and resolved threads out of the pass and counts them", async () => {
      await thread("comment", at(4), "Audit after check instead.");
      await thread("question", { type: "document", blockId: "b1" }, "Why before check?");
      const done = await thread("comment", at(2), "Already fixed upstream.");
      await submit("request-changes", "One change.");
      await cli(["threads", "resolve", done.id, "--review", pid]);

      const out = await cli(["forge", "pass", "--review", pid]);
      expect(out["pass"].inline).toBe(1);
      expect(out["pass"].skipped).toBe(2);
      expect(out["skipped"].map((s: Out) => String(s["why"]).split(":")[0]).sort()).toEqual([
        "question",
        "resolved",
      ]);

      const file = await passFile(out);
      expect(file.comments).toHaveLength(1);
      expect(JSON.stringify(file)).not.toContain("Why before check?");
      expect(JSON.stringify(file)).not.toContain("Already fixed upstream.");
    }, 30_000);

    it("puts a thread with no line to anchor in the summary and names which", async () => {
      await thread("comment", at(4), "Audit after check instead.");
      await thread("comment", { type: "document", blockId: "b1", quote: "audit" }, "Say why here.");
      await thread("comment", at(0), "This whole file wants a header.");
      await submit("request-changes", "Two notes.");

      const out = await cli(["forge", "pass", "--review", pid]);
      expect(out["pass"].inline).toBe(1);
      expect(out["pass"].summary).toBe(2);
      expect(out["summary"].map((s: Out) => String(s["target"]))).toEqual([
        'document "audit"',
        "src/auth.ts (file)",
      ]);
      expect(String(out["summary"][0].why)).toContain("line");

      const file = await passFile(out);
      expect(file.comments).toHaveLength(1);
      expect(file.body).toContain("Two notes.");
      expect(file.body).toContain("Say why here.");
      expect(file.body).toContain("This whole file wants a header.");
      expect(file.body).toContain('document "audit"');
    }, 30_000);

    it("refuses an approve while threads are still open, and writes nothing", async () => {
      const open = await thread("comment", at(4), "Audit after check instead.");
      await submit("approve");

      const refused = await cli(["forge", "pass", "--review", pid], { expectCode: 1 });
      expect(refused["code"]).toBe("THREADS_OPEN");
      expect(String(refused["error"])).toContain("approve");
      await expect(readFile(join(home, "passes", `${pid}.json`), "utf8")).rejects.toThrow();

      await cli(["threads", "resolve", open.id, "--review", pid]);
      const out = await cli(["forge", "pass", "--review", pid]);
      expect(out["pass"].verdict).toBe("approve");
      expect(out["pass"].inline).toBe(0);
      expect(String(out["comments"])).toMatch(/^0 /);
      expect((await passFile(out)).verdict).toBe("approve");
    }, 60_000);

    // The reader's own evidence for the resolved rule: a thread they reopened
    // after a pass would otherwise carry its first message to the forge twice.
    it("carries only what the reader wrote after the last answer", async () => {
      const th = await thread("comment", at(4), "Audit after check instead.");
      await submit("request-changes", "One change.");
      await cli(["threads", "reply", th.id, "--review", pid, "--body", "Moved it below check."]);
      await post(`/api/reviews/${pid}/threads/${th.id}/reply`, { body: "Line 5 is still wrong." });

      const file = await passFile(await cli(["forge", "pass", "--review", pid]));
      expect(file.comments).toHaveLength(1);
      expect(file.comments[0]!.body).toBe("Line 5 is still wrong.");
    }, 60_000);

    // Approve and close both end the review, and they are two of the three
    // decisions this command carries: it has to find one without --review.
    it("finds the review it carries after the reader has ended it", async () => {
      const solo = await mkdtemp(join(tmpdir(), "thurview-pass-repo-"));
      const env = {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      await sh(solo, "git", ["init", "-q", "-b", "main"], env);
      await writeFile(join(solo, "a.ts"), "export const a = 1;\n");
      await sh(solo, "git", ["add", "."], env);
      await sh(solo, "git", ["commit", "-q", "-m", "base"], env);
      await writeFile(join(solo, "a.ts"), "export const a = 2;\n");
      await sh(solo, "git", ["add", "."], env);
      await sh(solo, "git", ["commit", "-q", "-m", "change"], env);
      const solid = (await cli(["scaffold", "--base", "HEAD~1", "--head", "HEAD"], { cwd: solo }))[
        "review"
      ].uuid as string;
      await post(`/api/reviews/${solid}/threads`, {
        kind: "comment",
        mode: "review",
        target: { type: "document", blockId: "b1" },
        body: "Read the ordering once more.",
      });
      await post(`/api/reviews/${solid}/submit`, { decision: "close", body: "Superseded." });

      const out = await cli(["forge", "pass"], { cwd: solo });
      expect(out["pass"].review).toBe(solid.slice(0, 8));
      expect(out["pass"].verdict).toBe("comment");
      expect(out["pass"].summary).toBe(1);
      // The pass carries the reader's own words, so deleting the review takes it too.
      await cli(["delete", "--review", solid]);
      await expect(readFile(String(out["pass"].file), "utf8")).rejects.toThrow();
    }, 60_000);

    it("posts a closed review as a comment and says why it is not the decision", async () => {
      await thread("comment", at(4), "Audit after check instead.");
      await submit("close", "Superseded by the other branch.");

      const out = await cli(["forge", "pass", "--review", pid]);
      expect(out["pass"].verdict).toBe("comment");
      expect(out["pass"].decision).toBe("close");
      expect(String(out["pass"].why)).toContain("close");
      expect((await passFile(out)).verdict).toBe("comment");
    }, 30_000);
  });
});

describe("static snapshots", () => {
  it("includes shared pre-publication threads without inventing sealed draft context", async () => {
    const fixture = await cli(["scaffold", "--new"]);
    const id = fixture.review.uuid;
    await post(`/api/reviews/${id}/threads`, {
      kind: "question",
      mode: "ask",
      target: { type: "review" },
      body: "A question before first publish",
    });
    await cli(["publish", "--review", id]);
    const out = join(home, "early-thread");
    await cli(["publish-static", id, "--out", out]);
    const md = await readFile(join(out, "feedback.md"), "utf8");
    expect(md).toContain("A question before first publish");
    expect(md).toContain("unpublished draft");
  }, 30_000);

  it("renders a self-contained read-only static snapshot and deploys the archive", async () => {
    const fixture = await cli(["scaffold", "--new"]);
    const id = fixture.review.uuid;
    const dir = fixture.review.dir;
    const output = join(home, "static-test");
    const draft = await cli(["publish-static", id, "--out", output], { expectCode: 2 });
    expect(draft.error).toContain("published revision");
    await writeFile(
      join(dir, "review.md"),
      "# Snapshot fixture\n\n[Login](anchor:login) checks the user.\n",
    );
    await writeFile(
      join(dir, "data.yaml"),
      "anchors:\n  login: { title: Login, peek: { file: src/auth.ts, from: 3, to: 5 } }\n",
    );
    await writeFile(
      join(dir, "map.yaml"),
      "nodes:\n  - { id: auth, kind: component, label: Authentication, anchor: login, files: [src/auth.ts] }\nedges: []\n",
    );
    await cli(["publish", "--review", id]);
    const thread = (await post(`/api/reviews/${id}/threads`, {
      kind: "question",
      mode: "ask",
      target: { type: "review" },
      body: "Snapshot question",
    })) as Out;
    await cli(["threads", "reply", thread.id, "--review", id, "--body", "Snapshot answer"]);
    await post(`/api/reviews/${id}/threads`, {
      kind: "comment",
      mode: "review",
      target: { type: "review" },
      body: "Private unsubmitted draft",
    });
    await cli(["publish-static", id, "--out", output]);
    const html = await readFile(join(output, "index.html"), "utf8");
    expect(html.includes("Snapshot of revision")).toBe(true);
    expect(html).toContain("comments are made on the live review");
    const match =
      /<script type="application\/json" id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(html)!;
    const snapshot = JSON.parse(match[1]!);
    expect(snapshot.payload.document.anchors.login.peek.file).toBe("src/auth.ts");
    expect(snapshot.files["head:src/auth.ts"].lines.join("")).toContain("audit");
    expect(snapshot.banner.revision).toBe(1);
    expect(html).toContain("audit");
    expect(html).toContain("Authentication");
    expect(html).toContain("Files");
    expect(html).toContain("Snapshot question");
    expect(html).toContain("Snapshot answer");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/src="https?:|url\("https?:/i);
    expect(snapshot.payload.review.worktree).toBe("");
    expect(html).not.toContain(repo);

    expect(await readFile(join(output, "feedback.md"), "utf8")).toContain("Snapshot answer");
    expect(await readFile(join(output, "feedback.md"), "utf8")).not.toContain(
      "Private unsubmitted draft",
    );
    expect(await readFile(join(output, "feedback.md"), "utf8")).toContain("Target: Review overall");
    const config = join(home, "cloudflare.json");
    await writeFile(
      config,
      JSON.stringify({ name: "review-fixtures", publicUrl: "https://reviews.example.com" }),
    );
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "wrangler"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
if (args[0] !== "deploy" || !c.assets.directory || c.name !== "review-fixtures") process.exit(1);
fs.writeFileSync(${JSON.stringify(join(home, "deployment.json"))}, JSON.stringify(c));
if (fs.existsSync(${JSON.stringify(join(home, "edit-during-deploy"))})) {
  const file = ${JSON.stringify(join(dir, "review.json"))};
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  review.title = "Edited during deployment";
  fs.writeFileSync(file, JSON.stringify(review));
  fs.writeFileSync(${JSON.stringify(join(home, "state-after-deploy.json"))}, JSON.stringify(review));
}
if (fs.existsSync(${JSON.stringify(join(home, "fail-deploy"))})) process.exit(1);
`,
    );
    await chmod(join(bin, "wrangler"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + ":" + savedPath;
    try {
      const uninitialized = await cli(
        ["publish-static", id, "--to", "cloudflare", "--config", config],
        { expectCode: 2 },
      );
      expect(uninitialized.error).toContain("archive is missing");
      const first = await cli([
        "publish-static",
        id,
        "--to",
        "cloudflare",
        "--config",
        config,
        "--initialize-archive",
      ]);
      expect(first.snapshot.url).toMatch(
        /^https:\/\/reviews.example.com\/r\/[^/]+\/[^/]+\/[a-f0-9]{32}\/$/,
      );
      const deployed = JSON.parse(await readFile(join(home, "deployment.json"), "utf8"));
      const relative = new URL(first.snapshot.url).pathname;
      const firstPage = join(deployed.assets.directory, relative, "index.html");
      expect(await readFile(firstPage, "utf8")).toContain("Snapshot fixture");
      const secondFixture = await cli(["scaffold", "--new"]);
      await cli(["publish", "--review", secondFixture.review.uuid]);
      await cli([
        "publish-static",
        secondFixture.review.uuid,
        "--to",
        "cloudflare",
        "--config",
        config,
      ]);
      expect(await readFile(firstPage, "utf8")).toContain("Snapshot fixture");
      await writeFile(join(home, "edit-during-deploy"), "");
      const again = await cli(["publish-static", id, "--to", "cloudflare", "--config", config]);
      expect(again.snapshot.url).toBe(first.snapshot.url);
      const stored = JSON.parse(await readFile(join(dir, "review.json"), "utf8"));
      expect(stored.title).toBe("Edited during deployment");
      expect(await readFile(join(dir, "review.json"), "utf8")).toBe(
        await readFile(join(home, "state-after-deploy.json"), "utf8"),
      );
      const info = await cli(["info", "--fields", "uuid,staticSnapshot"]);
      expect(info.reviews.find((r: Out) => r.uuid === id).staticSnapshot.url).toBe(
        first.snapshot.url,
      );
      await writeFile(join(home, "fail-deploy"), "");
      const failed = await cli(["publish-static", id, "--to", "cloudflare", "--config", config], {
        expectCode: 2,
      });
      expect(failed.error).toContain("wrangler deploy failed");
      await rm(join(home, "fail-deploy"));
      await writeFile(
        config,
        JSON.stringify({ name: "review-fixtures", publicUrl: "https://alias.example.com" }),
      );
      const alias = await cli(["publish-static", id, "--to", "cloudflare", "--config", config]);
      expect(new URL(alias.snapshot.url).pathname).toBe(new URL(first.snapshot.url).pathname);
      expect(alias.snapshot.snapshots).toBe(2);
      await writeFile(
        config,
        JSON.stringify({ name: "review-fixtures", publicUrl: "https://reviews.example.com" }),
      );
      const fresh = (await cli(["scaffold", "--new"])).review.uuid;
      await cli(["publish", "--review", fresh]);
      const archive = dirname(deployed.assets.directory);
      const backup = join(home, "archive-backup");
      await rename(archive, backup);
      try {
        const lost = await cli(
          ["publish-static", fresh, "--to", "cloudflare", "--config", config],
          { expectCode: 2 },
        );
        expect(lost.error).toContain("archive is missing");
        const reset = await cli(
          [
            "publish-static",
            fresh,
            "--to",
            "cloudflare",
            "--config",
            config,
            "--initialize-archive",
          ],
          { expectCode: 2 },
        );
        expect(reset.error).toContain("require restoring the archive");
      } finally {
        await rm(archive, { recursive: true, force: true });
        await rename(backup, archive);
      }
      await rm(firstPage);
      const incomplete = await cli(
        ["publish-static", secondFixture.review.uuid, "--to", "cloudflare", "--config", config],
        { expectCode: 2 },
      );
      expect(incomplete.error).toContain("archive is incomplete");
    } finally {
      process.env["PATH"] = savedPath;
    }
  }, 60_000);
});
