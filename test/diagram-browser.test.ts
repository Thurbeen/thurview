// The review page, rendered by a real browser and measured, for what a
// geometry check without one cannot see: text that runs out of its box, off
// the drawing, or down to a size nobody can read. Then a design driven as a
// reader drives it - a table wider than a phone, a flow whose steps are
// sentences, proposals to open and a decision to make - by keyboard as well as
// by mouse, at a desktop and at a phone width. One browser and one server for
// all of it: a cold browser per suite was more than a CI runner would start.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { browserBin, launchBrowser, type Browser } from "./browser.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

let tmp: string;
let server: { port: number; close(): Promise<void> };
let browser: Browser;
let devtools: number;
let reviewId: string;
let designId: string;

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

// Steps worded the way a real design words them: whole sentences, longer than
// one line of a box. `failed` runs straight down, where a label
// centred on its edge sits on the line it names.
const FLOW_LABELS = {
  seen: "Poll lists the change request open at head H",
  gate: "Draft, bot, stop label, or H already reviewed?",
  idle: "Idle until the next poll comes round",
  lease: "Lease (repo, change request, H); quota allows the runner?",
  run: "Agent runs one review pass in a fresh worktree",
  verify: "Summary marker head is H, and the head is still H?",
  superseded: "Superseded: queue it again at the new head",
  retry: "Attempts left before the job is blocked?",
  done: "Reviewed at H",
};

const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${i + 1} explains one more part of the plan in enough words to wrap across the column and take up some room on the page.`,
  ).join("\n\n");

const DESIGN = (rev: number) => `# A scheduler for recurring reviews

## Summary

Revision ${rev}. Move the recurring reviewer into [a small scheduler](anchor:loop) of its own.

\`\`\`peek
loop
\`\`\`

${filler(3)}

## How it works today

| Data | Owner | Where |
| --- | --- | --- |
| repos, runners, policies | the operator | \`~/.config/scheduler/config.toml\` |
| schedule, lease, attempts, last error | the scheduler | \`~/.local/state/scheduler/<repo>/<change-request>.json\`, written atomically |

${filler(4)}

### One change request, one head

\`\`\`flow
label: Job lifecycle for one change request at head H
steps:
  - { id: seen, label: "${FLOW_LABELS.seen}", actor: daemon, next: gate }
  - { id: gate, label: "${FLOW_LABELS.gate}", actor: daemon, when: [{ case: skip, to: idle }, { case: new head, to: lease }] }
  - { id: idle, label: "${FLOW_LABELS.idle}", actor: daemon, next: seen }
  - { id: lease, label: "${FLOW_LABELS.lease}", actor: daemon, when: [{ case: deferred, to: idle }, { case: granted, to: run }] }
  - { id: run, label: "${FLOW_LABELS.run}", actor: daemon, anchor: loop, next: verify }
  - { id: verify, label: "${FLOW_LABELS.verify}", actor: daemon, when: [{ case: head moved, to: superseded }, { case: failed, to: retry }, { case: verified, to: done }] }
  - { id: superseded, label: "${FLOW_LABELS.superseded}", actor: daemon, next: seen }
  - { id: retry, label: "${FLOW_LABELS.retry}", actor: daemon, when: [{ case: yes, to: idle }, { case: no, to: done }] }
  - { id: done, label: "${FLOW_LABELS.done}", actor: daemon }
\`\`\`

${filler(4)}

### New pushes and rewrites

${filler(6)}

## Migration

${filler(6)}

### Decisions needed

${filler(14)}

### Open questions

${filler(1)}

## What was dropped {collapsed}

${filler(2)}
`;

const DESIGN_DATA = `actors:
  daemon: { label: scheduler daemon }
anchors:
  loop: { title: the loop today, peek: { file: src/plan.ts, from: 1, to: 3 } }
interfaces:
  repoAdd:
    name: scheduler repo add <forge-url> [--runner <id>]
    change: added
    capability: Pick any repository and have every change request on it reviewed.
    anchor: loop
  loopGone:
    name: the hand-run review loop
    change: removed
    capability: No session is started by hand to review a repository.
    anchor: loop
`;

const MOUSE = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

// One DevTools session per page, driven over the protocol the same way
// scripts/browser-check.mjs does, so the suite needs no browser library. It
// opens the review unless told which document to open and what marks it drawn.
async function page(
  width: number,
  height: number,
  os: "light" | "dark" = "light",
  doc: { id: string; ready: string } = { id: reviewId, ready: "svg.seq" },
) {
  const target = (await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { id: string; webSocketDebuggerUrl: string };
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
  const KEYS: Record<string, number> = { Enter: 13, Escape: 27, " ": 32 };
  // A real key press, so a button answers it with the click a keyboard makes.
  const press = async (key: string) => {
    const base = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: KEYS[key] };
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}),
    });
    await call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await new Promise((r) => setTimeout(r, 100));
  };
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: os }],
  });
  const open = async () => {
    await call("Page.navigate", { url: `http://127.0.0.1:${server.port}/review/${doc.id}` });
    await evaluate(`new Promise((ok, no) => {
    const t = Date.now();
    (function wait() {
      if (document.querySelector(${JSON.stringify(doc.ready)}) && document.fonts.status === "loaded") return ok(true);
      if (Date.now() - t > 15000) return no(new Error("the page did not render ${doc.ready}"));
      setTimeout(wait, 100);
    })();
  })`);
  };
  await open();
  // A tab left open keeps running in the background and slows every later one.
  const close = () => {
    ws.close();
    return fetch(`http://127.0.0.1:${devtools}/json/close/${target.id}`).then(() => {});
  };
  return { evaluate, press, reload: open, close };
}

/** The design, which the reader-facing checks below drive. */
const reader = (width: number, height: number) =>
  page(width, height, "light", { id: designId, ready: "article.doc svg.flow" });

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
    // A design beside it, published twice so the page offers the revision picker.
    const { design } = await cli(repo, home, ["design", "src"]);
    designId = design.id;
    for (const rev of [1, 2]) {
      await writeFile(join(design.dir, "review.md"), DESIGN(rev));
      await writeFile(join(design.dir, "data.yaml"), DESIGN_DATA);
      await cli(repo, home, ["publish", "--review", designId]);
    }

    process.env["THURVIEW_HOME"] = home;
    const { startServer } = await import(join(ROOT, "dist", "server", "server.js"));
    server = await startServer({ hosts: ["127.0.0.1"] });

    browser = await launchBrowser(join(tmp, "profile"), 60_000, MOUSE);
    devtools = browser.devtools;
  }, 150_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }, 30_000);

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

  it("follows the OS palette until the reader picks one, and remembers the pick", async () => {
    const p = await page(1440, 900, "dark");
    const seen = () =>
      p.evaluate<{ theme: string; bg: string }>(`({
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
      })`);
    // the menu's theme item cycles system -> light -> dark -> system
    const pick = () =>
      p.evaluate<string>(`(async () => {
        document.querySelector(".bar-more").click();
        await new Promise((r) => setTimeout(r, 50));
        const item = [...document.querySelectorAll(".def-popover .item")].find((e) => e.textContent.startsWith("Theme"));
        item.click();
        return localStorage.getItem("thurview.theme");
      })()`);
    const system = await seen();
    expect(system.theme).toBe("dark");
    expect(await pick()).toBe("light");
    const light = await seen();
    expect(light.theme).toBe("light");
    expect(light.bg).not.toBe(system.bg);
    await p.reload();
    expect((await seen()).theme).toBe("light");
    expect(await pick()).toBe("dark");
    expect((await seen()).bg).toBe(system.bg);
    expect(await pick()).toBe("system");
    expect((await seen()).theme).toBe("dark");
    // with site data blocked the pick still applies, for this page
    await p.evaluate(`Storage.prototype.setItem = () => { throw new Error("blocked"); }`);
    await pick();
    expect((await seen()).theme).toBe("light");
    p.close();
  }, 30_000);
  for (const width of [1280, 320])
    it(`exports matching Markdown through the reader controls (${width}px)`, async () => {
      const p = await page(width, 800);
      try {
        const result = await p.evaluate<{
          preview: boolean;
          clipboard: boolean;
          download: boolean;
          fallback: boolean;
          fits: boolean;
        }>(`(async () => {
          [...document.querySelectorAll("button")].find(b => b.textContent === "Export for agent").click();
          await new Promise((ok, no) => {
            const start = Date.now();
            (function wait() {
              if (document.querySelector(".export-preview")) return ok();
              if (Date.now() - start > 5000) return no(new Error("export dialog did not load"));
              setTimeout(wait, 50);
            })();
          });
          const preview = document.querySelector(".export-preview");
          const exported = await fetch("/api/reviews/${reviewId}/export").then(r => r.json());
          let copied;
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async text => { copied = text; },
          } });
          const buttons = [...document.querySelector(".dialog").querySelectorAll("button")];
          const copy = buttons.find(b => b.textContent === "Copy to clipboard");
          copy.click();
          await new Promise(r => setTimeout(r, 10));
          let download;
          const original = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function() { download = { url: this.href, name: this.download }; };
          try { buttons.find(b => b.textContent === "Download .md").click(); }
          finally { HTMLAnchorElement.prototype.click = original; }
          const downloaded = await fetch(download.url).then(r => r.text());
          navigator.clipboard.writeText = async () => { throw new Error("denied"); };
          copy.click();
          await new Promise(r => setTimeout(r, 10));
          const rect = document.querySelector(".dialog").getBoundingClientRect();
          return {
            preview: preview.value === exported.markdown && preview.value.includes("## What to do"),
            clipboard: copied === exported.markdown,
            download: downloaded === exported.markdown && download.name.endsWith(".md"),
            fallback: preview.selectionStart === 0 && preview.selectionEnd === preview.value.length,
            fits: buttons.every(b => { const box = b.getBoundingClientRect(); return box.left >= rect.left && box.right <= rect.right; }),
          };
        })()`);
        expect(result).toEqual({
          preview: true,
          clipboard: true,
          download: true,
          fallback: true,
          fits: true,
        });
      } finally {
        p.close();
      }
    }, 30_000);
  it("keeps a wide table inside its own scroller on a phone, not the whole page", async () => {
    const p = await reader(390, 844);
    try {
      const m = await p.evaluate<{ column: number; table: number }>(`(() => {
        const c = document.querySelector(".center");
        const t = document.querySelector(".doc table");
        return { column: c.scrollWidth - c.clientWidth, table: t.getBoundingClientRect().right - innerWidth };
      })()`);
      expect.soft(m.column).toBe(0);
      expect.soft(m.table).toBeLessThanOrEqual(0);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("leaves a code peek's lines as wide as their frame", async () => {
    const p = await reader(1440, 900);
    try {
      const m = await p.evaluate<{ display: string; short: number }>(`(() => {
        const code = document.querySelector(".doc .code-frame .code");
        const t = code.querySelector("table");
        return {
          display: getComputedStyle(t).display,
          short: code.clientWidth - t.querySelector("tr").getBoundingClientRect().width,
        };
      })()`);
      expect.soft(m.display).toBe("table");
      expect.soft(m.short).toBeLessThanOrEqual(1);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("shows every tab and the revision picker on a phone", async () => {
    const p = await reader(390, 844);
    try {
      const m = await p.evaluate<{
        hidden: string[];
        picker: boolean;
        name: string | null;
      }>(`(() => {
        const tabs = document.querySelector(".bar-actions .tabs");
        const strip = tabs.getBoundingClientRect();
        const hidden = [...tabs.querySelectorAll("button")]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.left < strip.left - 1 || r.right > strip.right + 1 || r.right > innerWidth; })
          .map((b) => b.textContent);
        const sel = document.querySelector(".topbar select");
        const r = sel && sel.getBoundingClientRect();
        return {
          hidden,
          picker: !!r && r.width > 0 && r.right <= innerWidth,
          name: sel && (sel.getAttribute("aria-label") ?? sel.labels?.[0]?.textContent ?? null),
        };
      })()`);
      expect.soft(m.hidden).toEqual([]);
      expect.soft(m.picker).toBe(true);
      expect.soft(m.name).toBe("Revision");
    } finally {
      await p.close();
    }
  }, 30_000);

  it("marks the section being read in the contents, subsections included", async () => {
    const p = await reader(1440, 900);
    try {
      const active = await p.evaluate<string[]>(`(async () => {
        const seen = [];
        const c = document.querySelector(".center");
        const read = async () => {
          await new Promise((r) => setTimeout(r, 250));
          seen.push(document.querySelector(".toc a.active")?.textContent ?? null);
        };
        for (const text of ["How it works today", "New pushes and rewrites", "Decisions needed"]) {
          const h = [...document.querySelectorAll(".doc h2, .doc h3")].find((e) => e.textContent.startsWith(text));
          c.scrollTop += h.getBoundingClientRect().top - c.getBoundingClientRect().top - 10;
          await read();
        }
        // The last sections never reach the top of the view; the end marks them.
        c.scrollTop = c.scrollHeight;
        await read();
        return seen;
      })()`);
      expect(active).toEqual([
        "How it works today",
        "New pushes and rewrites",
        "Decisions needed",
        "What was dropped",
      ]);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("marks the first section at the top of a document not much taller than the view", async () => {
    const tall = await reader(1440, 900);
    const height = await tall.evaluate<number>(`document.querySelector(".center").scrollHeight`);
    await tall.close();
    // Less than a view left to scroll, so all of the scroll is the last screen.
    const p = await reader(1440, Math.round(height * 0.6));
    try {
      const active = await p.evaluate<string | null>(`(async () => {
        await new Promise((r) => setTimeout(r, 250));
        return document.querySelector(".toc a.active")?.textContent ?? null;
      })()`);
      expect(active).toBe("Summary");
    } finally {
      await p.close();
    }
  }, 30_000);

  it("hides and shows a section from the keyboard", async () => {
    const p = await reader(1440, 900);
    try {
      const focus = () =>
        p.evaluate<{ focused: boolean; expanded: string | null; collapsed: boolean }>(`(() => {
          const h = [...document.querySelectorAll(".doc h2")].find((e) => e.textContent.startsWith("Migration"));
          const t = h.querySelector(".heading-toggle");
          t.focus();
          return { focused: document.activeElement === t, expanded: t.getAttribute("aria-expanded"), collapsed: !!h.closest(".section-collapsed") };
        })()`);
      const before = await focus();
      expect(before).toEqual({ focused: true, expanded: "true", collapsed: false });
      await p.press("Enter");
      expect(await focus()).toEqual({ focused: true, expanded: "false", collapsed: true });
    } finally {
      await p.close();
    }
  }, 30_000);

  it("opens a proposal's code from the keyboard", async () => {
    const p = await reader(1440, 900);
    try {
      const focused = await p.evaluate<boolean>(`(() => {
        const row = document.querySelector(".ifd-entry");
        row.focus();
        return document.activeElement === row;
      })()`);
      expect(focused).toBe(true);
      await p.press("Enter");
      const peek = await p.evaluate<string>(
        `document.querySelector(".side:not(.hidden) .side-head .path")?.textContent ?? ""`,
      );
      expect(peek).toContain("src/plan.ts");
    } finally {
      await p.close();
    }
  }, 30_000);

  it("shows the comment button that has focus, and opens its popover beside it", async () => {
    const p = await reader(1440, 900);
    try {
      const shown = await p.evaluate<{
        opacity: string;
        at: { x: number; y: number };
      }>(`(async () => {
        const b = document.querySelector(".doc .block .block-actions button");
        b.focus();
        await new Promise((r) => setTimeout(r, 200));
        const r = b.getBoundingClientRect();
        return { opacity: getComputedStyle(b.parentElement).opacity, at: { x: r.left, y: r.bottom } };
      })()`);
      expect.soft(shown.opacity).toBe("1");
      await p.press("Enter");
      const pop = await p.evaluate<{ x: number; y: number; typing: boolean } | null>(`(() => {
        const e = document.querySelector(".comment-popover");
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, typing: document.activeElement === e.querySelector("textarea") };
      })()`);
      expect(pop).not.toBeNull();
      expect.soft(Math.abs(pop!.y - shown.at.y)).toBeLessThan(40);
      expect.soft(Math.abs(pop!.x - shown.at.x)).toBeLessThan(60);
      expect.soft(pop!.typing).toBe(true);
      await p.press("Escape");
    } finally {
      await p.close();
    }
  }, 30_000);

  it("names what the decision's buttons do, and closes it with Escape", async () => {
    const p = await reader(1440, 900);
    try {
      const d = await p.evaluate<{
        role: string | null;
        inside: boolean;
        buttons: string[];
      }>(`(async () => {
        [...document.querySelectorAll(".bar-actions button")].find((b) => b.textContent === "Decide").click();
        await new Promise((r) => setTimeout(r, 100));
        const dlg = document.querySelector(".dialog");
        return {
          role: dlg.getAttribute("role"),
          inside: dlg.contains(document.activeElement),
          buttons: [...dlg.querySelectorAll("button")].map((b) => b.textContent),
        };
      })()`);
      expect.soft(d.role).toBe("dialog");
      expect.soft(d.inside).toBe(true);
      // "Close" beside "Cancel" read as a second way out, and it ended the design.
      expect
        .soft(d.buttons)
        .toEqual(["Cancel", "Drop the design", "Send it back", "Approve the design"]);
      await p.press("Escape");
      expect(await p.evaluate<boolean>(`!!document.querySelector(".overlay")`)).toBe(false);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("opens the menu from the keyboard, beside its button, on its first entry", async () => {
    const p = await reader(1440, 900);
    try {
      const at = await p.evaluate<{ x: number; y: number }>(`(() => {
        const b = document.querySelector(".bar-more");
        b.focus();
        const r = b.getBoundingClientRect();
        return { x: r.left, y: r.bottom };
      })()`);
      await p.press("Enter");
      const menu = await p.evaluate<{ y: number; first: boolean }>(`(() => {
        const m = document.querySelector(".def-popover");
        return {
          y: m.getBoundingClientRect().top,
          first: document.activeElement === m.querySelector(".item") && document.activeElement.getAttribute("role") === "button",
        };
      })()`);
      expect.soft(Math.abs(menu.y - at.y)).toBeLessThan(40);
      expect.soft(menu.first).toBe(true);
      await p.press("Escape");
    } finally {
      await p.close();
    }
  }, 30_000);

  // After every test that reads the comment buttons: the thread it leaves
  // makes its block's button show for good.
  it("opens a thread from its pin by keyboard", async () => {
    await fetch(`http://127.0.0.1:${server.port}/api/reviews/${designId}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "comment",
        mode: "review",
        target: { type: "document", blockId: "interface-delta" },
        body: "Which runner does the first repository use?",
      }),
    });
    const p = await reader(1440, 900);
    try {
      const focused = await p.evaluate<boolean>(`(() => {
        const pin = document.querySelector(".ifd .thread-pin");
        pin.focus();
        return document.activeElement === pin;
      })()`);
      expect(focused).toBe(true);
      await p.press("Enter");
      expect(
        await p.evaluate<boolean>(`!!document.querySelector(".side:not(.hidden) .thread.active")`),
      ).toBe(true);
    } finally {
      await p.close();
    }
  }, 30_000);

  for (const [name, width] of [
    ["desktop", 1440],
    ["phone", 390],
  ] as const)
    it(`writes every flow step out in full, inside its box (${name})`, async () => {
      const p = await reader(width, 900);
      try {
        const m = await p.evaluate<{
          labels: string[];
          outside: string[];
          crossed: string[];
          fontPx: number;
          pageOverflow: number;
        }>(`(() => {
          const svg = document.querySelector("svg.flow");
          const inside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
          const steps = [...svg.querySelectorAll("g.step")];
          const labels = steps.map((g) => [...g.querySelectorAll("text:not(.who)")].map((t) => t.textContent).join(" "));
          const outside = steps
            .filter((g) => [...g.querySelectorAll("text")].some((t) => !inside(t.getBBox(), g.querySelector("rect, path").getBBox())))
            .map((g) => g.querySelector("title").textContent);
          // A forward edge's label sits on no line: not its own, nor a
          // sibling's. A loop's lane label is left to the lanes' own layout.
          const segments = [...svg.querySelectorAll("g.edge path")].flatMap((p) => {
            const out = [];
            let x = 0, y = 0;
            for (const n of p.getAttribute("d").match(/[MVH][^MVH]*/g)) {
              const v = n.slice(1).split(",").map(Number);
              const from = { x, y };
              if (n[0] === "M") { x = v[0]; y = v[1]; continue; }
              if (n[0] === "V") y = v[0]; else x = v[0];
              out.push({ minX: Math.min(from.x, x), maxX: Math.max(from.x, x), minY: Math.min(from.y, y), maxY: Math.max(from.y, y) });
            }
            return out;
          });
          const crossed = [...svg.querySelectorAll("g.edge:not(.back) text")]
            .filter((t) => {
              const b = t.getBBox();
              return segments.some((s) => s.minX <= b.x + b.width && s.maxX >= b.x && s.minY <= b.y + b.height && s.maxY >= b.y);
            })
            .map((t) => t.textContent);
          const scale = svg.getScreenCTM().a;
          const fontPx = Math.min(...steps.flatMap((g) => [...g.querySelectorAll("text:not(.who)")]).map((t) => parseFloat(getComputedStyle(t).fontSize) * scale));
          const c = document.querySelector(".center");
          return { labels, outside, crossed, fontPx, pageOverflow: c.scrollWidth - c.clientWidth };
        })()`);
        expect.soft(m.labels).toEqual(Object.values(FLOW_LABELS));
        expect.soft(m.outside).toEqual([]);
        expect.soft(m.crossed).toEqual([]);
        // Readable on a phone: it scrolls inside its frame instead of shrinking.
        expect.soft(m.fontPx).toBeGreaterThanOrEqual(10.8);
        expect.soft(m.pageOverflow).toBe(0);
      } finally {
        await p.close();
      }
    }, 30_000);
});
