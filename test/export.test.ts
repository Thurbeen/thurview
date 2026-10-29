// A published document, exported to one static HTML file and opened from disk
// with no thurview server running: it must render every section and snippet,
// ask the network for nothing, name no server, and come out byte-identical
// every time it is exported.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { browserBin, launchBrowser, type Browser } from "./browser.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

let tmp: string;
let home: string;
let repo: string;
let reviewId: string;
let withThreads: string;
let withoutThreads: string;
let staticPage: string;
let largePage: string;
let largeHead: string;
let largeOriginal: string;
let migratedPage: string;

// The built command, the one a user runs: the export inlines the bundled UI.
async function cli(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await execFileP(
    process.execPath,
    [join(ROOT, "bin", "thurview.js"), ...args],
    {
      cwd: repo,
      env: { ...process.env, THURVIEW_HOME: home, ...env },
    },
  );
  return decode(stdout.trim()) as Record<string, any>;
}

const REVIEW = `# Audit every login

[login](anchor:login) now records who tried before it checks them.

## Data flow

\`\`\`sequence
label: Login
messages:
  - { from: caller, to: auth, label: login(user), anchor: login }
  - { from: auth, to: log, label: audit(user), anchor: audit }
\`\`\`

## The audit call

\`\`\`peek
audit
\`\`\`

## What stays the same

\`\`\`peek
check
\`\`\`
`;

const DATA = `actors:
  caller: { label: Caller }
  auth: { label: Auth }
  log: { label: Audit log }
anchors:
  login: { title: login(), peek: { file: src/auth.ts, from: 1, to: 4 } }
  audit: { title: audit(), peek: { file: src/audit.ts, from: 1, to: 3 } }
  check: { title: check(), peek: { file: src/auth.ts, from: 6, to: 8 } }
architecture:
  view: Auditing is one new module, called from login().
`;

const SECTIONS = ["Audit every login", "Data flow", "The audit call", "What stays the same"];
const SNIPPETS = [
  'console.log("login", user);',
  "export function audit(user: string) {",
  "return user.length > 0;",
];
const VERDICT = "Keep the audit out of the login path.";
const THREAD = "Should a failed login be audited too?";

beforeAll(async () => {
  await execFileP(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: ROOT,
  });
  await execFileP(process.execPath, ["scripts/build-ui.mjs"], { cwd: ROOT });

  await mkdir(join(ROOT, "node_modules", ".cache"), { recursive: true });
  tmp = await mkdtemp(join(ROOT, "node_modules", ".cache", "thurview-export-"));
  home = join(tmp, "home");
  repo = join(tmp, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  const git = (...a: string[]) =>
    execFileP(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
      { cwd: repo },
    );
  await git("init", "-q", "-b", "main");
  await writeFile(
    join(repo, "src", "auth.ts"),
    "export function login(user: string) {\n  return check(user);\n}\n\nfunction check(user: string) {\n  return user.length > 0;\n}\n",
  );
  await writeFile(join(repo, "NOTES.md"), "# notes\n\nkept as it was\n");
  await writeFile(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  await git("checkout", "-q", "-b", "feature");
  // touched and put back: in the Commits tab, but not in the net diff
  await writeFile(join(repo, "NOTES.md"), "# notes\n\nbriefly different\n");
  await git("commit", "-qam", "try a note");
  await writeFile(join(repo, "NOTES.md"), "# notes\n\nkept as it was\n");
  await git("commit", "-qam", "put the note back");
  await writeFile(join(repo, "logo.bin"), Buffer.from([0, 9, 9, 0, 255, 0]));
  await writeFile(
    join(repo, "src", "auth.ts"),
    'import { audit } from "./audit";\nexport function login(user: string) {\n  audit(user);\n  return check(user);\n}\nfunction check(user: string) {\n  return user.length > 0;\n}\n',
  );
  await writeFile(
    join(repo, "src", "audit.ts"),
    'export function audit(user: string) {\n  console.log("login", user);\n}\n',
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "audit logins");
  const { review } = await cli(["scaffold"]);
  reviewId = review.uuid;
  await writeFile(join(review.dir, "review.md"), REVIEW);
  await writeFile(join(review.dir, "data.yaml"), DATA);
  await cli(["publish", "--review", reviewId]);

  // A reader's comment, left through the server the way the browser leaves it,
  // which is then shut down: the export must need none of it.
  process.env["THURVIEW_HOME"] = home;
  const { startServer } = await import(join(ROOT, "dist", "server", "server.js"));
  const server = await startServer({ hosts: ["127.0.0.1"] });
  await fetch(`http://127.0.0.1:${server.port}/api/reviews/${reviewId}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "comment",
      mode: "ask",
      target: { type: "review" },
      body: THREAD,
    }),
  });
  // and a verdict with words of its own, which --no-threads keeps out as well
  await fetch(`http://127.0.0.1:${server.port}/api/reviews/${reviewId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "request-changes", body: VERDICT }),
  });
  await server.close();

  withThreads = join(tmp, "out", "review.html");
  withoutThreads = join(tmp, "out", "bare");
  staticPage = join(tmp, "static", "index.html");
  await cli(["publish-static", reviewId, "--out", join(tmp, "static")]);
  await cli(["export", "--review", reviewId, "--out", withThreads]);
  await cli(["export", "--review", reviewId, "--out", withoutThreads, "--no-threads"]);

  // A real pinned 73-file change: syntax highlighting duplicates source in
  // the diff and expandable context, pushing the old export over 25 MiB.
  for (let i = 0; i < 73; i++) {
    await writeFile(
      join(repo, "src", `large-${i}.ts`),
      Array.from(
        { length: 500 },
        (_, line) => `export const value${line} = "file-${i}-line-${line}-retained";`,
      ).join("\n") + "\n",
    );
  }
  await git("add", ".");
  await git("commit", "-qm", "large pinned change");
  largeHead = (await git("rev-parse", "HEAD")).stdout.trim();
  const large = (await cli(["scaffold", "--base", "HEAD~1"])).review;
  await writeFile(join(large.dir, "review.md"), "# Large review\n\n```peek\nlast\n```\n");
  await writeFile(
    join(large.dir, "data.yaml"),
    "anchors:\n  last: { title: Last retained line, peek: { file: src/large-72.ts, from: 500, to: 500 } }\narchitecture: { view: Fits. }\n",
  );
  await cli(["publish", "--review", large.uuid]);
  await cli(["publish", "--review", large.uuid]);
  // Move the checkout after sealing: exports must still use the sealed head.
  await writeFile(join(repo, "src", "large-72.ts"), "unsealed replacement\n");
  await git("commit", "-qam", "move checkout");
  largePage = join(tmp, "large", "index.html");
  await cli(["publish-static", large.uuid, "--out", join(tmp, "large")]);
  largeOriginal = join(tmp, "large-original.html");
  await cli(["export", "--review", large.uuid, "--out", largeOriginal]);
}, 120_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe("thurview export", () => {
  it("keeps a large pinned static export below the hosting asset limit", async () => {
    const html = await readFile(largePage);
    expect(html.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024);
    const original = await readFile(largeOriginal, "utf8");
    expect(Buffer.byteLength(original)).toBeGreaterThan(25 * 1024 * 1024);
    const embedded = (text: string) =>
      /<script type="application\/json" id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(
        text,
      )![1]!;
    const hosted = JSON.parse(
      gunzipSync(Buffer.from(embedded(html.toString()), "base64")).toString(),
    );
    const offline = JSON.parse(embedded(original));
    delete hosted.banner;
    expect(hosted).toEqual(offline);
    const again = join(tmp, "large-again");
    await cli(["publish-static", hosted.payload.review.id, "--out", again]);
    expect(await readFile(join(again, "index.html"))).toEqual(html);
    expect(existsSync(join(tmp, "large", "feedback.md"))).toBe(false);
  }, 60_000);
  it("repairs an oversized retained snapshot when deploying a different review", async () => {
    const { exportReview } = await import(join(ROOT, "dist", "export.js"));
    const { readReview } = await import(join(ROOT, "dist", "store.js"));
    const original = await readFile(largeOriginal, "utf8");
    const raw = JSON.parse(/id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(original)![1]!);
    const large = await readReview(raw.payload.review.id);
    const legacy = await exportReview(large, {
      threads: true,
      banner: { revision: 2, sha: largeHead },
    });
    expect(Buffer.byteLength(legacy)).toBeGreaterThan(25 * 1024 * 1024);
    const name = "retained-fixtures";
    const root = join(home, "static", createHash("sha256").update(name).digest("hex"));
    const retained = `r/repo/legacy/${"a".repeat(32)}/`;
    const prior = `r/repo/prior/${"b".repeat(32)}/`;
    migratedPage = join(root, "assets", retained, "index.html");
    await mkdir(join(root, "assets", retained), { recursive: true });
    await mkdir(join(root, "assets", prior), { recursive: true });
    await writeFile(migratedPage, legacy);
    const md = "# Legacy large review feedback\n";
    await writeFile(join(root, "assets", retained, "feedback.md"), md);
    const oldPage = await readFile(staticPage);
    const oldMd = "# Legacy review feedback\n";
    await writeFile(join(root, "assets", prior, "index.html"), oldPage);
    await writeFile(join(root, "assets", prior, "feedback.md"), oldMd);
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({
        account_id: null,
        snapshots: { [large.id]: retained, "archived-only": prior },
      }),
    );
    // The archive is authoritative even if its author's local review is gone.
    await rm(join(home, "reviews", large.id), { recursive: true, force: true });
    const config = join(tmp, "retained-cloudflare.json");
    await writeFile(config, JSON.stringify({ name, publicUrl: "https://reviews.example.com" }));
    const bin = join(tmp, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "wrangler"),
      `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config")+1]));
function check(dir) { for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
  const file = path.join(dir,e.name); if(e.isDirectory()) check(file);
  else if(fs.statSync(file).size > 25*1024*1024) { fs.writeFileSync(${JSON.stringify(join(tmp, "asset-too-large"))}, file); console.error("Asset too large"); process.exit(1); }
} }
check(config.assets.directory);
fs.appendFileSync(${JSON.stringify(join(tmp, "deploy-called"))}, "deploy\\n");
`,
    );
    await chmod(join(bin, "wrangler"), 0o755);
    const small = JSON.parse(
      /id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(oldPage.toString())![1]!,
    );
    const requested = (
      await cli([
        "scaffold",
        "--new",
        "--base",
        small.payload.review.pins.base,
        "--head",
        small.payload.review.pins.head,
      ])
    ).review;
    await writeFile(join(requested.dir, "review.md"), REVIEW);
    await writeFile(join(requested.dir, "data.yaml"), DATA);
    await cli(["publish", "--review", requested.uuid]);
    const env = { PATH: `${bin}:${process.env["PATH"]}` };
    const deployed = await cli(
      ["publish-static", requested.uuid, "--to", "cloudflare", "--config", config],
      env,
    ).catch(async (e: { stdout: string }) => {
      expect((decode(e.stdout.trim()) as Record<string, any>).error).toContain(
        "wrangler deploy failed",
      );
      expect(await readFile(join(tmp, "asset-too-large"), "utf8")).toContain("legacy");
      throw new Error("retained legacy archive deployment: Asset too large");
    });
    expect(deployed.snapshot.snapshots).toBe(3);
    const repaired = await readFile(migratedPage, "utf8");
    expect(Buffer.byteLength(repaired)).toBeLessThanOrEqual(25 * 1024 * 1024);
    const data = /id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(repaired)![1]!;
    expect(JSON.parse(gunzipSync(Buffer.from(data, "base64")).toString())).toEqual(
      JSON.parse(/id="thurview-snapshot">([\s\S]*?)<\/script>/.exec(legacy)![1]!),
    );
    expect(existsSync(join(root, "assets", retained, "feedback.md"))).toBe(false);
    expect(await readFile(join(root, "assets", prior, "index.html"))).toEqual(oldPage);
    expect(existsSync(join(root, "assets", prior, "feedback.md"))).toBe(false);
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    expect(index.snapshots[large.id]).toBe(retained);
    await cli(["publish-static", requested.uuid, "--to", "cloudflare", "--config", config], env);
    expect(await readFile(migratedPage, "utf8")).toBe(repaired);
    const unsupported = join(root, "assets", "unsupported", "index.html");
    await mkdir(join(root, "assets", "unsupported"));
    const unrecognized = Buffer.alloc(25 * 1024 * 1024 + 1, "x");
    await writeFile(unsupported, unrecognized);
    const calls = await readFile(join(tmp, "deploy-called"));
    const refused = await cli(
      ["publish-static", requested.uuid, "--to", "cloudflare", "--config", config],
      env,
    ).catch((e: { stdout: string }) => decode(e.stdout.trim()) as Record<string, any>);
    expect(refused.error).toContain("oversized archived snapshot cannot be compacted");
    expect(Buffer.compare(await readFile(unsupported), unrecognized)).toBe(0);
    expect(await readFile(join(tmp, "deploy-called"))).toEqual(calls);
  }, 60_000);

  it("writes one self-contained file that names no server and no local path", async () => {
    const html = await readFile(withThreads, "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    // The bundled app still holds the paths it asks a server for, never taken
    // here; what must be absent is any server's address and this review's own
    // endpoints.
    for (const server of ["localhost", "127.0.0.1", `/api/reviews/${reviewId}`])
      expect(html).not.toContain(server);
    expect(html).not.toMatch(/(src|href)="\/(?!\/)/);
    expect(html).not.toContain(repo);
    expect(html).not.toContain(home);
    // the browser itself is told to fetch nothing from anywhere
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(THREAD);
  });

  it("follows the reader's light or dark palette, like the served page", async () => {
    const html = await readFile(withThreads, "utf8");
    const index = await readFile(join(import.meta.dirname, "..", "src/ui/index.html"), "utf8");
    const boot = /<script>([\s\S]*?)<\/script>/.exec(index)![1]!.trim();
    // the served page's boot script, before the stylesheet, so nothing paints in the wrong palette
    expect(html.indexOf(boot)).toBeGreaterThan(-1);
    expect(html.indexOf(boot)).toBeLessThan(html.indexOf("<style>"));
  });

  // An uploaded copy can end up on a public URL; it must never be indexed.
  it("asks search engines not to index or follow the copy", async () => {
    const html = await readFile(withThreads, "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(`<meta name="robots" content="noindex, nofollow" />`);
  });

  it("writes a folder target as its index.html, and leaves threads out when asked", async () => {
    const bare = await readFile(join(withoutThreads, "index.html"), "utf8");
    expect(bare).not.toContain(THREAD);
    expect(bare).not.toContain(VERDICT);
    expect(bare).toContain("The audit call");
  });

  it("leaves a changed binary file's bytes out, since nothing shows them", async () => {
    const html = await readFile(withThreads, "utf8");
    expect(html).toContain(`"logo.bin"`);
    expect(html).not.toContain(`"head:logo.bin"`);
  });

  it("comes out byte-identical every time", async () => {
    const again = join(tmp, "out", "again.html");
    await cli(["export", "--review", reviewId, "--out", again]);
    expect(await readFile(again, "utf8")).toBe(await readFile(withThreads, "utf8"));
  });

  it("refuses a review that was never published", async () => {
    const { review } = await cli(["scaffold", "--new"]);
    const refused = await cli([
      "export",
      "--review",
      review.uuid,
      "--out",
      join(tmp, "x.html"),
    ]).catch((e: { stdout: string }) => e);
    expect(String((refused as { stdout?: string }).stdout)).toMatch(/is not published yet/);
    expect(existsSync(join(tmp, "x.html"))).toBe(false);
  });
});

describe.skipIf(!browserBin)("an exported document in a browser, offline", () => {
  let browser: Browser;
  let devtools: number;

  beforeAll(async () => {
    browser = await launchBrowser(join(tmp, "profile"));
    devtools = browser.devtools;
  }, 90_000);

  afterAll(() => browser?.close(), 30_000);

  // Open `file` from disk with the network switched off, record every request
  // the page makes, and wait until `ready` holds.
  async function open(file: string, hash: string, ready: string) {
    const target = (await (
      await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: "PUT" })
    ).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    const requests: string[] = [];
    const errors: string[] = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) pending.get(m.id)!(m.result ?? m.error);
      if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
      if (m.method === "Runtime.exceptionThrown")
        errors.push(m.params.exceptionDetails.exception?.description ?? "exception");
    });
    const call = (method: string, params: object = {}) =>
      new Promise<any>((resolve) => {
        pending.set(++id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value as T;
    };
    await call("Network.enable");
    await call("Runtime.enable");
    await call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await call("Page.navigate", { url: pathToFileURL(file).href + hash });
    await evaluate(`new Promise((ok, no) => {
      const t = Date.now();
      (function wait() {
        if (${ready}) return ok(true);
        if (Date.now() - t > 15000) return no(new Error("never ready: " + document.body.innerText.slice(0, 400)));
        setTimeout(wait, 100);
      })();
    })`);
    return { evaluate, requests, errors, call, close: () => ws.close() };
  }

  it("opens the large sealed snapshot with retained anchors and diffs offline", async () => {
    const p = await open(
      migratedPage,
      "",
      `document.body?.innerText.includes("file-72-line-499-retained")`,
    );
    try {
      const text = await p.evaluate<string>("document.body.innerText");
      expect(text).toContain(largeHead);
      expect(text).toContain("Snapshot of revision 2 at");
      expect(text).toContain("file-72-line-499-retained");
      expect(text).not.toContain("unsealed replacement");
      const snap = await p.evaluate<any>(
        `JSON.parse(document.getElementById("thurview-snapshot").textContent)`,
      );
      expect(snap.payload.changes).toHaveLength(73);
      expect(Object.keys(snap.diffs)).toHaveLength(73);
      expect(Object.keys(snap.files)).toHaveLength(73);
      await p.evaluate(`location.hash = "#/files?path=src%2Flarge-0.ts"`);
      await p.evaluate(
        `new Promise((ok, no) => { const start = Date.now(); (function wait() { if (document.querySelector(".file-view")?.innerText.includes("file-0-line-499-retained")) return ok(true); if (Date.now()-start > 15000) return no(new Error("diff missing")); setTimeout(wait,100); })(); })`,
      );
      expect(
        await p.evaluate<number>(
          `[...document.querySelectorAll("button")].filter(b => b.offsetParent && /^(Decide|Submit.*)$/.test(b.textContent)).length`,
        ),
      ).toBe(0);
      expect(p.errors).toEqual([]);
      expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
    } finally {
      p.close();
    }
  }, 60_000);

  it("opens the static snapshot offline with its banner and anchors", async () => {
    const p = await open(staticPage, "", `document.querySelector("svg.seq")`);
    try {
      const text = await p.evaluate<string>("document.body.innerText");
      expect(text).toContain("Snapshot of revision 1 at");
      expect(text).toContain("comments are made on the live review");
      for (const snippet of SNIPPETS) expect(text).toContain(snippet);
      const links = await p.evaluate<string[]>(
        `[...document.querySelectorAll(".banner a")].map(a => a.getAttribute("href"))`,
      );
      expect(links).toEqual([]);
      await p.call("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const fits = await p.evaluate<boolean>(
        `document.querySelector(".banner").getBoundingClientRect().right <= innerWidth`,
      );
      expect(fits).toBe(true);
      expect(p.errors).toEqual([]);
      expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
    } finally {
      p.close();
    }
  }, 30_000);

  it("renders every section, snippet and diagram, and asks the network for nothing", async () => {
    const p = await open(withThreads, "", `document.querySelector("svg.seq")`);
    const text = await p.evaluate<string>("document.body.innerText");
    for (const s of SECTIONS) expect.soft(text).toContain(s);
    for (const s of SNIPPETS) expect.soft(text).toContain(s);
    // nothing to write with: a published copy is read only
    const decide = await p.evaluate<number>(
      `[...document.querySelectorAll("button")].filter((b) => b.offsetParent && /^(Decide|Submit.*|\\+|Comment on .*|Export for agent)$/.test(b.textContent)).length`,
    );
    p.close();
    expect.soft(decide).toBe(0);
    expect.soft(p.errors).toEqual([]);
    expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
  }, 30_000);

  it("shows the reader's threads as static notes", async () => {
    const p = await open(
      withThreads,
      "#/review?side=threads",
      `document.querySelector(".side:not(.hidden)")`,
    );
    const side = await p.evaluate<string>(`document.querySelector(".side").innerText`);
    const reply = await p.evaluate<number>(`document.querySelectorAll(".side textarea").length`);
    p.close();
    expect.soft(side).toContain(THREAD);
    expect.soft(reply).toBe(0);
    expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
  }, 30_000);

  it("opens a file the Commits tab lists though the net diff does not", async () => {
    const p = await open(
      withThreads,
      "#/files?path=NOTES.md",
      `document.querySelector(".file-view table")`,
    );
    const text = await p.evaluate<string>(`document.querySelector(".file-view").innerText`);
    p.close();
    expect.soft(text).toContain("kept as it was");
    expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
  }, 30_000);

  it("shows the diff of every changed file without the server", async () => {
    const p = await open(
      withThreads,
      "#/files?path=src%2Faudit.ts",
      `document.querySelector(".file-view table")`,
    );
    const text = await p.evaluate<string>(`document.querySelector(".file-view").innerText`);
    p.close();
    expect.soft(text).toContain('console.log("login", user);');
    expect.soft(p.errors).toEqual([]);
    expect(p.requests.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
  }, 30_000);
});
