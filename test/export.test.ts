// A published document, exported to one static HTML file and opened from disk
// with no thurview server running: it must render every section and snippet,
// ask the network for nothing, name no server, and come out byte-identical
// every time it is exported.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The built command, the one a user runs: the export inlines the bundled UI.
async function cli(args: string[]) {
  const { stdout } = await execFileP(
    process.execPath,
    [join(ROOT, "bin", "thurview.js"), ...args],
    {
      cwd: repo,
      env: { ...process.env, THURVIEW_HOME: home },
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
`;

const SECTIONS = ["Audit every login", "Data flow", "The audit call", "What stays the same"];
const SNIPPETS = [
  'console.log("login", user);',
  "export function audit(user: string) {",
  "return user.length > 0;",
];
const THREAD = "Should a failed login be audited too?";

beforeAll(async () => {
  await execFileP(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: ROOT,
  });
  await execFileP(process.execPath, ["scripts/build-ui.mjs"], { cwd: ROOT });

  tmp = await mkdtemp(join(tmpdir(), "thurview-export-"));
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
  await server.close();

  withThreads = join(tmp, "out", "review.html");
  withoutThreads = join(tmp, "out", "bare");
  await cli(["export", "--review", reviewId, "--out", withThreads]);
  await cli(["export", "--review", reviewId, "--out", withoutThreads, "--no-threads"]);
}, 120_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe("thurview export", () => {
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

  it("writes a folder target as its index.html, and leaves threads out when asked", async () => {
    const bare = await readFile(join(withoutThreads, "index.html"), "utf8");
    expect(bare).not.toContain(THREAD);
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
    const { explainer } = await cli(["explain", "--new"]);
    const refused = await cli([
      "export",
      "--review",
      explainer.uuid,
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
    return { evaluate, requests, errors, close: () => ws.close() };
  }

  it("renders every section, snippet and diagram, and asks the network for nothing", async () => {
    const p = await open(withThreads, "", `document.querySelector("svg.seq")`);
    const text = await p.evaluate<string>("document.body.innerText");
    for (const s of SECTIONS) expect.soft(text).toContain(s);
    for (const s of SNIPPETS) expect.soft(text).toContain(s);
    // nothing to write with: a published copy is read only
    const decide = await p.evaluate<number>(
      `[...document.querySelectorAll("button")].filter((b) => b.offsetParent && /^(Decide|Submit.*|\\+|Comment on .*)$/.test(b.textContent)).length`,
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
