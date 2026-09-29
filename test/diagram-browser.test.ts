// The review page, rendered by a real browser and measured, for what a
// geometry check without one cannot see: text that runs out of its box, off
// the drawing, or down to a size nobody can read.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const browserBin =
  process.env["CHROMIUM"] ??
  ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
    .flatMap((b) => (process.env["PATH"] ?? "").split(delimiter).map((d) => join(d, b)))
    .find((p) => existsSync(p));

let tmp: string;
let server: { port: number; close(): Promise<void> };
let browser: ChildProcess;
let devtools: number;
let reviewId: string;

async function cli(repo: string, home: string, args: string[]) {
  const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const { stdout } = await execFileP(process.execPath, [tsx, join(ROOT, "src/main.ts"), ...args], {
    cwd: repo,
    env: { ...process.env, THURVIEW_HOME: home },
  });
  return decode(stdout.trim()) as Record<string, any>;
}

// Actor names as long as a real system's, and messages longer than the gap
// between the two lifelines they join - the last one ending at the rightmost
// actor, where there is no room left to centre it.
const REVIEW = `# Adopt the old state

\`\`\`sequence
label: Adopting one root
messages:
  - { from: operator, to: legacyRepo, label: plan each source unit and stop unless the exit code is 0, anchor: plan }
  - { from: operator, to: legacyState, label: read the resource ids without writing the state, anchor: plan }
  - { from: pipeline, to: newState, label: "merge-request plan: N to import, 0 add, 0 destroy, 0 replace", anchor: plan }
  - { from: pipeline, to: pipeline, label: wait for the merge, code: "await merge()" }
  - { from: newState, to: operator, label: hand the lock back once the apply has made every update, anchor: plan }
\`\`\`
`;

const DATA = `actors:
  operator: { label: Operator on the jump host }
  legacyRepo: { label: legacy infrastructure repository }
  legacyState: { label: legacy infrastructure state }
  pipeline: { label: new repository pipeline }
  newState: { label: new repository state }
anchors:
  plan: { title: plan(), peek: { file: src/plan.ts, from: 1, to: 3 } }
`;

// One DevTools session per page, driven over the protocol the same way
// scripts/browser-check.mjs does, so the suite needs no browser library.
async function page(width: number, height: number) {
  const target = (await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m.result ?? m.error);
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
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.port}/review/${reviewId}` });
  await evaluate(`new Promise((ok, no) => {
    const t = Date.now();
    (function wait() {
      if (document.querySelector("svg.seq") && document.fonts.status === "loaded") return ok(true);
      if (Date.now() - t > 15000) return no(new Error("no sequence diagram rendered"));
      setTimeout(wait, 100);
    })();
  })`);
  return { evaluate, close: () => ws.close() };
}

interface Measured {
  fontPx: number[];
  actorsOverflowing: string[];
  actorsOverlapping: number;
  textsOffDrawing: string[];
  textsOverlapping: string[];
  labelsLeftOfTheirArrow: string[];
  pageOverflow: number;
  frameOverflow: number;
  buttons: number;
}

// Every measure is taken in the SVG's own units against its own viewBox, so
// the scale the browser draws it at cannot hide a label that does not fit.
const MEASURE = `(() => {
  const svg = document.querySelector("svg.seq");
  const vb = svg.viewBox.baseVal;
  const texts = [...svg.querySelectorAll("text")];
  const box = (e) => e.getBBox();
  const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const actors = [...svg.querySelectorAll(".actor")].map((g) => ({
    rect: box(g.querySelector("rect")),
    text: g.querySelector("text"),
  }));
  let actorsOverlapping = 0;
  actors.forEach((a, i) => actors.slice(i + 1).forEach((b) => (actorsOverlapping += hit(a.rect, b.rect))));
  const textsOverlapping = [];
  texts.forEach((a, i) => texts.slice(i + 1).forEach((b) => {
    if (hit(box(a), box(b))) textsOverlapping.push(a.textContent + " / " + b.textContent);
  }));
  const frame = svg.closest(".diagram").getBoundingClientRect();
  return {
    fontPx: texts.map((t) => parseFloat(getComputedStyle(t).fontSize) * svg.getScreenCTM().a),
    actorsOverflowing: actors
      .filter(({ rect, text }) => { const t = box(text); return t.x < rect.x || t.x + t.width > rect.x + rect.width || t.y < rect.y || t.y + t.height > rect.y + rect.height; })
      .map(({ text }) => text.textContent),
    actorsOverlapping,
    textsOffDrawing: texts
      .filter((t) => { const b = box(t); return b.x < vb.x || b.x + b.width > vb.x + vb.width; })
      .map((t) => t.textContent),
    textsOverlapping,
    labelsLeftOfTheirArrow: [...svg.querySelectorAll(".msg")]
      .filter((g) => {
        const shape = box(g.querySelector("line, path"));
        return box(g.querySelector("text")).x < shape.x;
      })
      .map((g) => g.querySelector("text").textContent),
    // Only a scroll container scrolls, so those are what the page's own
    // overflow is read from; a frame bleeding into its column's padding is not.
    pageOverflow: Math.max(
      document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      ...(function up(e) {
        if (!e) return [];
        const scrolls = /auto|scroll/.test(getComputedStyle(e).overflowX);
        return [scrolls ? e.scrollWidth - e.clientWidth : 0, ...up(e.parentElement)];
      })(svg.closest(".diagram").parentElement),
    ),
    frameOverflow: Math.max(0, frame.right - innerWidth, -frame.left),
    buttons: svg.querySelectorAll('.msg [role="button"][tabindex="0"]').length,
  };
})()`;

describe.skipIf(!browserBin)("review page in a browser", () => {
  beforeAll(async () => {
    // The server serves the built UI, so build it from this checkout first.
    await execFileP(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
      cwd: ROOT,
    });
    await execFileP(process.execPath, ["scripts/build-ui.mjs"], { cwd: ROOT });

    tmp = await mkdtemp(join(tmpdir(), "thurview-browser-"));
    const home = join(tmp, "home");
    const repo = join(tmp, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    const git = (...a: string[]) =>
      execFileP("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "src", "plan.ts"), "export function plan() {\n  return 0;\n}\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "src", "plan.ts"), "export function plan() {\n  return 1;\n}\n");
    await git("commit", "-qam", "plan");
    const { review } = await cli(repo, home, ["scaffold"]);
    reviewId = review.uuid;
    await writeFile(join(review.dir, "review.md"), REVIEW);
    await writeFile(join(review.dir, "data.yaml"), DATA);
    await cli(repo, home, ["publish", "--review", reviewId]);

    process.env["THURVIEW_HOME"] = home;
    const { startServer } = await import(join(ROOT, "dist", "server", "server.js"));
    server = await startServer({ hosts: ["127.0.0.1"] });

    const port = (devtools = 9800 + Math.floor(Math.random() * 400));
    browser = spawn(
      browserBin!,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${join(tmp, "profile")}`,
        `--remote-debugging-port=${port}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(`http://127.0.0.1:${port}/json/version`).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 90_000);

  afterAll(async () => {
    // Chromium keeps writing its profile until it has exited, so the temporary
    // tree is removed only after that, not as soon as the kill is sent.
    if (browser && browser.exitCode === null) {
      const exited = new Promise((r) => browser.once("exit", r));
      browser.kill();
      await exited;
    }
    await server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  for (const [name, width, height] of [
    ["desktop", 1440, 900],
    ["phone", 390, 844],
  ] as const)
    it(`draws a sequence whose every label is inside its box and readable (${name})`, async () => {
      const p = await page(width, height);
      const m = await p.evaluate<Measured>(MEASURE);
      p.close();
      expect.soft(m.actorsOverflowing).toEqual([]);
      expect.soft(m.actorsOverlapping).toBe(0);
      expect.soft(m.textsOffDrawing).toEqual([]);
      expect.soft(m.textsOverlapping).toEqual([]);
      expect.soft(m.labelsLeftOfTheirArrow).toEqual([]);
      // Shrunk no further than 90% of its 12px, so a phone gets a diagram it
      // scrolls across rather than one shrunk to fit and too small to read.
      expect.soft(Math.min(...m.fontPx)).toBeGreaterThanOrEqual(10.8);
      // The frame scrolls inside the column; the page itself never does.
      expect.soft(m.pageOverflow).toBe(0);
      expect.soft(m.frameOverflow).toBe(0);
      // Every message that opens code answers the keyboard, not only the mouse.
      expect.soft(m.buttons).toBe(5);
    }, 30_000);
});
