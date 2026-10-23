// Browser regression for the built queue: synthetic rows, no review store or live service.
// Run after pnpm build: node scripts/list-scroll-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const rows = Array.from({ length: 60 }, (_, i) => ({
  id: `fixture-${i}`,
  title: `Synthetic review ${i + 1}`,
  kind: "review",
  binding: { kind: "branch", name: "fixture" },
  updatedAt: new Date().toISOString(),
  dismissed: i >= 50,
  openThreads: 0,
  queue: { repo: "example/project", turn: "you", why: "Ready for review" },
}));
const server = createServer(async (req, res) => {
  if (req.url === "/api/reviews") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(rows));
    return;
  }
  const path = req.url === "/" ? "index.html" : req.url.slice(1);
  if (!/^(index\.html|app\.(css|js)|assets\/[\w/.-]+)$/.test(path)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader(
      "Content-Type",
      path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".html")
            ? "text/html"
            : "font/woff2",
    );
    res.end(await readFile(resolve("dist/ui", path)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const profile = await mkdtemp(resolve("dist", "scroll-browser-"));
const chrome = spawn(
  process.env.CHROMIUM || "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(`${profile}/DevToolsActivePort`, "utf8")).split("\n")[0]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(port, "Chromium must start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true });
    assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const pause = () => new Promise((r) => setTimeout(r, 350));
  for (const [width, height] of [
    [1280, 720],
    [800, 480],
    [390, 640],
  ]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 40; i++) {
      if (await evaluate("document.querySelectorAll('.home .item').length === 60")) break;
      await pause();
    }
    assert.equal(await evaluate("document.querySelectorAll('.home .item').length"), 60);
    const metrics = () =>
      evaluate(
        "({top:document.querySelector('.home').getBoundingClientRect().top, pageTop:scrollY, appTop:document.querySelector('#app').scrollTop, height:document.querySelector('#app').clientHeight, content:document.querySelector('#app').scrollHeight, bodyOverflow:getComputedStyle(document.body).overflowY})",
      );
    const before = await metrics();
    await call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: width / 2,
      y: height / 2,
      deltaX: 0,
      deltaY: 600,
    });
    await pause();
    const after = await metrics();
    console.log(JSON.stringify({ width, height, before, after }));
    assert.ok(after.top < before.top, "Wheel must move the queue");
    assert.equal(after.bodyOverflow, "auto", "Queue uses native page scrolling");
    await evaluate("document.activeElement.blur()");
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    });
    await pause();
    assert.ok(
      await evaluate(
        "document.querySelector('.home .item:last-child').getBoundingClientRect().bottom <= innerHeight",
      ),
      "End must reach dismissed rows at the bottom",
    );
  }
  rows.length = 1;
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await pause();
  assert.equal(await evaluate("document.querySelectorAll('.home .item').length"), 1);
  assert.equal(
    await evaluate(
      "document.querySelector('#app').scrollHeight === document.querySelector('#app').clientHeight",
    ),
    true,
    "Short queues must fit",
  );
  console.log("Queue scroll checks passed");
} finally {
  ws?.close();
  chrome.kill();
  await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  server.close();
  await rm(profile, { recursive: true, force: true });
}
