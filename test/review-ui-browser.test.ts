// The document page as a reader drives it: a design long enough to scroll, a
// table wider than a phone, a flow whose steps are sentences, proposals to open
// and a decision to make - all by keyboard as well as by mouse, at a desktop and
// at a phone width. Each check is something a real document was seen to get wrong.
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
let designId: string;

async function cli(repo: string, home: string, args: string[]) {
  const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const { stdout } = await execFileP(process.execPath, [tsx, join(ROOT, "src/main.ts"), ...args], {
    cwd: repo,
    env: { ...process.env, THURVIEW_HOME: home },
  }).catch((e) => {
    throw new Error(`thurview ${args.join(" ")}: ${e.stdout}${e.stderr}`);
  });
  return decode(stdout.trim()) as Record<string, any>;
}

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

const REVIEW = (rev: number) => `# A scheduler for recurring reviews

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

const DATA = `actors:
  daemon: { label: scheduler daemon }
anchors:
  loop: { title: the loop today, peek: { file: src/loop.ts, from: 1, to: 3 } }
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

// One DevTools session per page, over the protocol, as the other browser suites drive it.
async function page(width: number, height: number) {
  const target = (await (
    await fetch(`http://127.0.0.1:${browser.devtools}/json/new?about:blank`, { method: "PUT" })
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
  await call("Page.navigate", { url: `http://127.0.0.1:${server.port}/review/${designId}` });
  await evaluate(`new Promise((ok, no) => {
    const t = Date.now();
    (function wait() {
      if (document.querySelector("article.doc svg.flow") && document.fonts.status === "loaded") return ok(true);
      if (Date.now() - t > 15000) return no(new Error("the document did not render"));
      setTimeout(wait, 100);
    })();
  })`);
  // A tab left open keeps running in the background and slows every later one.
  const close = () => {
    ws.close();
    return fetch(`http://127.0.0.1:${browser.devtools}/json/close/${target.id}`).then(() => {});
  };
  return { evaluate, press, close };
}

describe.skipIf(!browserBin)("document page, driven by a reader", () => {
  beforeAll(async () => {
    // The server serves the built UI, so build it from this checkout first.
    await execFileP(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
      cwd: ROOT,
    });
    await execFileP(process.execPath, ["scripts/build-ui.mjs"], { cwd: ROOT });

    tmp = await mkdtemp(join(tmpdir(), "thurview-reader-"));
    const home = join(tmp, "home");
    const repo = join(tmp, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    const git = (...a: string[]) =>
      execFileP("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "src", "loop.ts"), "export function loop() {\n  return 0;\n}\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const { design } = await cli(repo, home, ["design", "src"]);
    designId = design.id;
    // Two revisions, so the page offers the revision picker.
    for (const rev of [1, 2]) {
      await writeFile(join(design.dir, "review.md"), REVIEW(rev));
      await writeFile(join(design.dir, "data.yaml"), DATA);
      await cli(repo, home, ["publish", "--review", designId]);
    }

    process.env["THURVIEW_HOME"] = home;
    const { startServer } = await import(join(ROOT, "dist", "server", "server.js"));
    server = await startServer({ hosts: ["127.0.0.1"] });
    browser = await launchBrowser(join(tmp, "profile"), 60_000, MOUSE);
  }, 150_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }, 30_000);

  it("keeps a wide table inside its own scroller on a phone, not the whole page", async () => {
    const p = await page(390, 844);
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
    const p = await page(1440, 900);
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
    const p = await page(390, 844);
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
    const p = await page(1440, 900);
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
    const tall = await page(1440, 900);
    const height = await tall.evaluate<number>(`document.querySelector(".center").scrollHeight`);
    await tall.close();
    // Less than a view left to scroll, so all of the scroll is the last screen.
    const p = await page(1440, Math.round(height * 0.6));
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
    const p = await page(1440, 900);
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
    const p = await page(1440, 900);
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
      expect(peek).toContain("src/loop.ts");
    } finally {
      await p.close();
    }
  }, 30_000);

  it("shows the comment button that has focus, and opens its popover beside it", async () => {
    const p = await page(1440, 900);
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
    const p = await page(1440, 900);
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
    const p = await page(1440, 900);
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
    const p = await page(1440, 900);
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
      const p = await page(width, 900);
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
