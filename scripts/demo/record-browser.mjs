// Reader side of the thurview demo: drive the review in headless Chromium over
// the DevTools protocol with a visible pointer, capture a screencast, and write
// it as a frame sequence for ffmpeg.
// Usage: node scripts/demo/record-browser.mjs <review-url> <frames-dir> [fps]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [url, framesDir, fpsArg = "15"] = process.argv.slice(2);
if (!url || !framesDir) {
  console.error("usage: record-browser.mjs <review-url> <frames-dir> [fps]");
  process.exit(2);
}
const W = 1280;
const H = 800;
const FPS = Number(fpsArg);
await mkdir(framesDir, { recursive: true });

const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 1500));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const frames = [];
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === "Page.screencastFrame") {
    frames.push({ t: m.params.metadata.timestamp, data: m.params.data });
    call("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
  }
  if (m.method === "Runtime.exceptionThrown")
    console.error("EXCEPTION", m.params.exceptionDetails.exception?.description);
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false,
});
await call("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 2500));

// A drawn pointer, since the screencast does not render the system cursor.
await call("Runtime.evaluate", {
  expression: `(() => { const c = document.createElement("div"); c.id = "demo-cursor"; c.style.cssText = "position:fixed;z-index:99999;width:18px;height:18px;border-radius:50%;background:rgba(255,92,84,.85);box-shadow:0 0 0 3px rgba(255,255,255,.6),0 0 12px rgba(255,59,48,.8);pointer-events:none;transform:translate(-50%,-50%);transition:left .35s ease,top .35s ease;left:40px;top:40px"; document.body.appendChild(c); })()`,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) =>
  (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
    .result?.value;
const rectOf = (selector, nth = 0) =>
  evalJs(
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
  );
async function moveTo(x, y) {
  await evalJs(
    `(() => { const c = document.getElementById("demo-cursor"); c.style.left = "${x}px"; c.style.top = "${y}px"; })()`,
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(450);
}
async function click(selector, { nth = 0, shift = false, offsetX = 0 } = {}) {
  const r = await rectOf(selector, nth);
  if (!r) {
    console.error("missing", selector);
    return false;
  }
  const x = Math.round(r.x + offsetX);
  const y = Math.round(r.y);
  await moveTo(x, y);
  const modifiers = shift ? 8 : 0;
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await sleep(350);
  return true;
}
async function scrollCenter(y, ms = 900) {
  await evalJs(`document.querySelector(".center").scrollTo({ top: ${y}, behavior: "smooth" })`);
  await sleep(ms);
}
async function type(text) {
  for (const ch of text) {
    await call("Input.insertText", { text: ch });
    await sleep(28);
  }
}

await call("Page.startScreencast", {
  format: "jpeg",
  quality: 85,
  maxWidth: W,
  maxHeight: H,
  everyNthFrame: 1,
});
const t0 = Date.now();

// 1. Read the document: summary, then follow an anchor into the code.
await sleep(1600);
await scrollCenter(260);
await click("a.anchor-link", { nth: 1 }); // "cap"
await sleep(1800);
await scrollCenter(700, 1200); // sequence diagram
await click(".seq .msg text", { nth: 2 }); // audit("login-denied")
await sleep(1600);
await click(".side-head button.ghost"); // close the peek

// 2. Files: a range comment held for the review.
await evalJs(`location.hash = "#/files?path=src%2Fauth.ts"`);
await sleep(1800);
await click('.split .code:last-child tr[data-head="9"] td.ln');
await sleep(300);
await call("Runtime.evaluate", {
  expression: `document.querySelector(".comment-popover")?.remove()`,
});
await click('.split .code:last-child tr[data-head="12"] td.ln', { shift: true });
await sleep(600);
await type(
  "Log the denied attempt after the throw is decided, so a failing audit write cannot mask the cap.",
);
await sleep(500);
await click(".comment-popover button.ok");
await sleep(1600);

// 3. Map: what the change added.
await evalJs(`location.hash = "#/map?node=svc.audit"`);
await sleep(2200);

// 4. Threads, then the decision.
await evalJs(`location.hash = "#/review"`);
await sleep(900);
await click(".topbar button", {
  nth: await evalJs(
    `[...document.querySelectorAll(".topbar button")].findIndex((b) => b.textContent.startsWith("Threads"))`,
  ),
});
await sleep(1800);
await click(".topbar button.primary");
await sleep(1200);
await type("One change before I approve, see the comment on the cap.");
await sleep(400);
await click(".dialog .row button", { nth: 1 }); // Request changes
await sleep(2200);

await call("Page.stopScreencast");
chrome.kill();

// Resample the timestamped frames to a constant rate.
frames.sort((a, b) => a.t - b.t);
const start = frames[0].t;
const end = frames[frames.length - 1].t + 1.5;
let fi = 0;
let n = 0;
for (let t = start; t < end; t += 1 / FPS) {
  while (fi + 1 < frames.length && frames[fi + 1].t <= t) fi++;
  await writeFile(
    join(framesDir, `f${String(n++).padStart(5, "0")}.jpg`),
    Buffer.from(frames[fi].data, "base64"),
  );
}
console.log(`frames: ${n} (${frames.length} captured, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(0);
