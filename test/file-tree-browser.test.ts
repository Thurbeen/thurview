import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, copyFile, cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { browserBin, launchBrowser, type Browser } from "./browser.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
let scratch: string;
let buildRoot: string;
let browser: Browser;
let server: { port: number; close(): Promise<void> };
let url: string;
let snapshot: string;
let explainerUrl: string;
let explainerSnapshot: string;

async function page(address = url, width = 1440, theme = "light") {
  const target = (await (
    await fetch(`http://127.0.0.1:${browser.devtools}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl: string; id: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const requests: string[] = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id) {
      pending.get(m.id)?.(m.result ?? m.error);
      pending.delete(m.id);
    }
    if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
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
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await call("Page.bringToFront");
  await call("Page.enable");
  await call("Network.enable");
  const reset = await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__treeReset = true; try { for (const key of Object.keys(localStorage)) if (key.startsWith("thurview.tree.")) localStorage.removeItem(key); } catch {}`,
  });
  await call("Page.navigate", { url: address });
  await evaluate(`new Promise((ok, no) => {
    const start = Date.now(); (function wait() {
      if (window.__treeReset && document.querySelector(${JSON.stringify(address.includes("/coverage") ? ".cov-intro" : ".file-view .code")})) return ok(true);
      if (Date.now() - start > 15000) return no(new Error('no diff'));
      setTimeout(wait, 50);
    })();
  })`);
  await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: reset.identifier });
  return {
    evaluate,
    call,
    requests,
    close: async () => {
      await call("Target.closeTarget", { targetId: target.id });
      ws.close();
    },
  };
}
const rows = ` [...document.querySelectorAll('[role="treeitem"]')].filter(e => e.getClientRects().length)`;
const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click()`;
const wait = `await new Promise(r => setTimeout(r, 200));`;
const key = (key: string) =>
  `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`;

// A test must outlive the page helper's 15-second readiness check on a cold browser.
describe.skipIf(!browserBin)("file explorer in the reader", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const cache = join(ROOT, "node_modules", ".cache");
    await mkdir(cache, { recursive: true });
    scratch = await mkdtemp(join(cache, "file-tree-"));
    // Other browser suites can compile while this one exports; its command and server
    // must read a build that none of those compilers can truncate underneath them.
    buildRoot = join(scratch, "build");
    await mkdir(join(buildRoot, "scripts"), { recursive: true });
    for (const path of ["src", "bin", "package.json", "tsconfig.json"])
      await cp(join(ROOT, path), join(buildRoot, path), { recursive: true });
    await copyFile(join(ROOT, "scripts/build-ui.mjs"), join(buildRoot, "scripts/build-ui.mjs"));
    await symlink(join(ROOT, "node_modules"), join(buildRoot, "node_modules"), "dir");
    await run("pnpm", ["build"], { cwd: buildRoot });
    const repo = join(scratch, "repo");
    const home = join(scratch, "home");
    await mkdir(join(repo, "src", "kernel", "host"), { recursive: true });
    await mkdir(join(repo, "docs"));
    const git = (...args: string[]) =>
      run(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo },
      );
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "src/kernel/host/main.ts"), "export const value = 0;\n");
    await writeFile(join(repo, "docs/old.md"), "old\n");
    await writeFile(join(repo, "docs/rename.md"), "rename stays the same\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("checkout", "-qb", "feature");
    await writeFile(
      join(repo, "src/kernel/host/main.ts"),
      Array.from({ length: 100 }, (_, i) => `export const value${i} = ${i};\n`).join(""),
    );
    await writeFile(join(repo, "src/kernel/host/new.ts"), "export const added = true;\n");
    await rm(join(repo, "docs/old.md"));
    await git("mv", "docs/rename.md", "docs/renamed.md");
    await git("add", ".");
    await git("commit", "-qm", "change");
    const cli = async (args: string[]) => {
      const { stdout } = await run(
        process.execPath,
        [join(buildRoot, "bin/thurview.js"), ...args],
        {
          cwd: repo,
          env: { ...process.env, THURVIEW_HOME: home },
        },
      );
      return decode(stdout.trim()) as Record<string, any>;
    };
    const { review } = await cli(["scaffold"]);
    await writeFile(
      join(review.dir, "review.md"),
      "# Host changes\n\n[Main](anchor:main) changes.\n",
    );
    await writeFile(
      join(review.dir, "data.yaml"),
      "anchors:\n  main: { title: Main, peek: { file: src/kernel/host/main.ts, from: 1, to: 2 } }\n",
    );
    await cli(["publish", "--review", review.uuid]);
    process.env["THURVIEW_HOME"] = home;
    const { startServer } = await import(join(buildRoot, "dist/server/server.js"));
    server = await startServer({ hosts: ["127.0.0.1"] });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/reviews/${review.uuid}/threads`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "comment",
          mode: "ask",
          target: { type: "file", path: "src/kernel/host/main.ts", side: "head", line: 1 },
          body: "Check this",
        }),
      },
    );
    expect(response.ok).toBe(true);
    snapshot = join(scratch, "snapshot.html");
    await cli(["export", "--review", review.uuid, "--out", snapshot]);
    url = `http://127.0.0.1:${server.port}/review/${review.uuid}#/files?path=src/kernel/host/main.ts`;
    const { explainer } = await cli(["explain"]);
    await writeFile(
      join(explainer.dir, "review.md"),
      "# Host code\n\n[Main](anchor:main) is the entry.\n",
    );
    await writeFile(
      join(explainer.dir, "data.yaml"),
      "anchors:\n  main: { title: Main, peek: { file: src/kernel/host/main.ts, from: 1, to: 2 } }\n",
    );
    await cli(["publish", "--review", explainer.id]);
    explainerUrl = `http://127.0.0.1:${server.port}/review/${explainer.id}#/coverage`;
    explainerSnapshot = join(scratch, "explainer.html");
    await cli(["export", "--review", explainer.id, "--out", explainerSnapshot]);
    browser = await launchBrowser(join(scratch, "profile"));
    // Cold navigation can outlast a test's default readiness budget.
    const ready = await page();
    await ready.close();
  }, 150000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }, 30000);

  it("allows browser readiness within the page helper's existing deadline", async () => {
    const slow = join(scratch, "slow-ready.html");
    await writeFile(
      slow,
      `<!doctype html><body><script>
      setTimeout(() => {
        document.body.innerHTML = '<div class="file-view"><div class="code">ready</div></div>';
      }, 6000);
    </script></body>`,
    );
    const p = await page(pathToFileURL(slow).href);
    expect(await p.evaluate(`document.querySelector('.file-view .code').textContent`)).toBe(
      "ready",
    );
    await p.close();
  });

  it("nests files under compact expandable folder chains", async () => {
    const p = await page();
    expect(
      await p.evaluate(`document.querySelector('[role="tree"]')?.getAttribute('aria-label')`),
    ).toBe("Files");
    expect(
      await p.evaluate(
        `document.querySelector('[data-folder="src/kernel/host"] .name')?.textContent`,
      ),
    ).toBe("src/kernel/host");
    expect(
      await p.evaluate(
        `document.querySelector('[data-folder="src/kernel/host"] [role="group"] [data-file="src/kernel/host/main.ts"]') !== null`,
      ),
    ).toBe(true);
    await p.close();
  });
  it("folds folders and expands and collapses all", async () => {
    const p = await page();
    await p.evaluate(click('[data-folder="src/kernel/host"]'));
    expect(
      await p.evaluate(`${rows}.some(e => e.dataset.file === 'src/kernel/host/main.ts')`),
    ).toBe(false);
    await p.evaluate(click('[aria-label="Expand all folders"]'));
    expect(await p.evaluate(`${rows}.filter(e => e.dataset.file).length`)).toBe(4);
    await p.evaluate(click('[aria-label="Collapse all folders"]'));
    expect(await p.evaluate(`${rows}.filter(e => e.dataset.file).length`)).toBe(0);
    await p.close();
  });
  it("opens a clicked file and marks it current", async () => {
    const p = await page();
    await p.evaluate(click('[data-file="src/kernel/host/new.ts"]'));
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('[data-file="src/kernel/host/new.ts"]').getAttribute('aria-selected'); })()`,
      ),
    ).toBe("true");
    expect(await p.evaluate(`location.hash.includes('new.ts')`)).toBe(true);
    await p.close();
  });
  it("keeps the current file highlighted as the diff scrolls", async () => {
    const p = await page();
    expect(
      await p.evaluate(`(async () => {
      const view = document.querySelector('.file-view');
      const section = view.querySelector('[data-path="src/kernel/host/new.ts"]');
      if (!section) return null;
      view.scrollTop = section.offsetTop - view.offsetTop;
      ${wait}
      return document.querySelector('[data-file="src/kernel/host/new.ts"]').getAttribute('aria-selected');
    })()`),
    ).toBe("true");
    await p.close();
  });
  it("filters by path and reveals matches inside folded folders", async () => {
    const p = await page();
    expect(
      await p.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Filter files"]');
      if (!input) return null;
      input.value = 'new.ts'; input.dispatchEvent(new Event('input'));
      return ${rows}.filter(e => e.dataset.file).map(e => e.dataset.file);
    })()`),
    ).toEqual(["src/kernel/host/new.ts"]);
    await p.evaluate(`document.querySelector('[data-folder="src/kernel/host"]').focus()`);
    await p.evaluate(key("ArrowLeft"));
    expect(
      await p.evaluate(
        `document.querySelector('[data-folder="src/kernel/host"]').getAttribute('aria-expanded')`,
      ),
    ).toBe("false");
    await p.close();
  });
  it("navigates with arrows, folds left and right, and opens with Enter", async () => {
    const p = await page();
    expect(
      await p.evaluate(`(() => {
      const folder = document.querySelector('[data-folder="src/kernel/host"]');
      if (!folder) return null;
      folder.focus(); ${key("ArrowLeft")}; ${key("ArrowRight")}; ${key("ArrowRight")};
      return document.activeElement.dataset.file;
    })()`),
    ).toBe("src/kernel/host/main.ts");
    await p.evaluate(key("ArrowDown"));
    await p.evaluate(key("Enter"));
    expect(
      await p.evaluate(`(async () => { ${wait} return location.hash.includes('new.ts'); })()`),
    ).toBe(true);
    await p.close();
  });
  it("renders statuses, rename origins, totals, comments and anchors", async () => {
    const p = await page();
    const text = await p.evaluate<string>(
      `document.querySelector('[role="tree"]')?.textContent ?? ''`,
    );
    expect(text).toContain("+101");
    expect(text).toContain("−1");
    expect(
      await p.evaluate(
        `document.querySelector('[data-file="src/kernel/host/main.ts"]')?.textContent`,
      ),
    ).toContain("M");
    expect(
      await p.evaluate(
        `document.querySelector('[data-file="src/kernel/host/new.ts"]')?.textContent`,
      ),
    ).toContain("A");
    expect(
      await p.evaluate(`document.querySelector('[data-file="docs/old.md"]')?.textContent`),
    ).toContain("D");
    expect(
      await p.evaluate(`document.querySelector('[data-file="docs/renamed.md"]')?.textContent`),
    ).toContain("docs/rename.md");
    expect(
      await p.evaluate(
        `document.querySelector('[data-file="src/kernel/host/main.ts"] [title="Anchored in the document"]') !== null`,
      ),
    ).toBe(true);
    expect(
      await p.evaluate(
        `document.querySelector('[data-file="src/kernel/host/main.ts"] [title="1 comment, 1 open thread"]') !== null`,
      ),
    ).toBe(true);
    await p.close();
  });
  it("works in the exported snapshot without network calls", async () => {
    const p = await page(`${pathToFileURL(snapshot).href}#/files?path=src/kernel/host/main.ts`);
    expect(await p.evaluate(`document.querySelector('[role="tree"]') !== null`)).toBe(true);
    await p.evaluate(click('[data-file="src/kernel/host/new.ts"]'));
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('[data-file="src/kernel/host/new.ts"]').getAttribute('aria-selected'); })()`,
      ),
    ).toBe("true");
    expect(p.requests.filter((r) => /^https?:/.test(r))).toEqual([]);
    await p.close();
  });
  it("puts a file tree beside the commits list", async () => {
    const p = await page();
    await p.evaluate(`location.hash = '#/commits'`);
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('.commits') && document.querySelector('[role="tree"]') !== null; })()`,
      ),
    ).toBe(true);
    await p.evaluate(click('[data-file="src/kernel/host/main.ts"]'));
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('.file-view .code') !== null; })()`,
      ),
    ).toBe(true);
    await p.close();
  });
  it("browses coverage files in live and offline explainers", async () => {
    for (const address of [explainerUrl, `${pathToFileURL(explainerSnapshot).href}#/coverage`]) {
      const p = await page(address);
      expect(await p.evaluate(`document.querySelector('[role="tree"]') !== null`)).toBe(true);
      await p.evaluate(click('[data-file="src/kernel/host/new.ts"]'));
      expect(
        await p.evaluate(
          `(async () => { ${wait} return document.querySelector('.file-view [data-path="src/kernel/host/new.ts"] .code')?.textContent; })()`,
        ),
      ).toContain("export const added = true;");
      if (address.startsWith("file:"))
        expect(p.requests.filter((r) => /^https?:/.test(r))).toEqual([]);
      await p.close();
    }
  });
  it("keeps the reader's position when the files view rerenders", async () => {
    const p = await page();
    const before = await p.evaluate<number>(`(async () => {
      const view = document.querySelector('.file-view'); view.scrollTop += 600;
      ${wait} return view.getBoundingClientRect().top - view.querySelector('[data-path="src/kernel/host/main.ts"]').getBoundingClientRect().top;
    })()`);
    await p.evaluate(`window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    const after = await p.evaluate<number>(
      `(async () => { ${wait} const view = document.querySelector('.file-view'); return view.getBoundingClientRect().top - view.querySelector('[data-path="src/kernel/host/main.ts"]').getBoundingClientRect().top; })()`,
    );
    expect(Math.abs(after - before)).toBeLessThan(2);
    await p.close();
  });
  it("renders both palettes without page overflow", async () => {
    const evidence = process.env["THURVIEW_TREE_EVIDENCE"];
    for (const theme of ["light", "dark"]) {
      const p = await page(url, 1440, theme);
      expect(await p.evaluate(`document.documentElement.dataset.theme`)).toBe(theme);
      expect(
        await p.evaluate(
          `document.documentElement.scrollWidth <= innerWidth && document.querySelector('.file-view').getBoundingClientRect().right <= innerWidth`,
        ),
      ).toBe(true);
      if (evidence) {
        await p.evaluate(`document.fonts.ready`);
        await mkdir(evidence, { recursive: true });
        const { data } = await p.call("Page.captureScreenshot", { format: "png" });
        await writeFile(join(evidence, `${theme}.png`), Buffer.from(data, "base64"));
        await copyFile(snapshot, join(ROOT, "node_modules/.cache/file-tree-snapshot.html"));
      }
      await p.close();
    }
  });
  it("remembers width and folds and provides a narrow drawer", async () => {
    const p = await page();
    expect(
      await p.evaluate(
        `document.querySelector('[role="separator"][aria-label="Resize file tree"]') !== null`,
      ),
    ).toBe(true);
    await p.evaluate(`document.querySelector('[role="separator"]').focus()`);
    await p.evaluate(key("ArrowRight"));
    expect(
      await p.evaluate(
        `document.querySelector('[role="separator"]').getAttribute('aria-valuenow')`,
      ),
    ).toBe("360");
    await p.evaluate(click('[data-folder="src/kernel/host"]'));
    await p.call("Page.reload");
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('[data-folder="src/kernel/host"]')?.getAttribute('aria-expanded'); })()`,
      ),
    ).toBe("false");
    expect(
      await p.evaluate(`document.querySelector('.file-list').getBoundingClientRect().width`),
    ).toBe(360);
    await p.evaluate(click('[aria-label="Hide file tree"]'));
    await p.call("Page.reload");
    expect(
      await p.evaluate(
        `(async () => { ${wait} return document.querySelector('.file-list').getBoundingClientRect().width; })()`,
      ),
    ).toBe(0);
    await p.close();
    const mobile = await page(url, 390);
    expect(
      await mobile.evaluate(`document.querySelector('.file-list').getBoundingClientRect().width`),
    ).toBe(0);
    await mobile.evaluate(click('[aria-label="Show file tree"]'));
    expect(
      await mobile.evaluate(`document.querySelector('.file-list').getBoundingClientRect().width`),
    ).toBeGreaterThan(200);
    await mobile.evaluate(click('[aria-label="Hide file tree"]'));
    expect(await mobile.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    await mobile.close();
  });
});
