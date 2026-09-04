// Drive headless Chromium over the DevTools protocol: print console output, exceptions and
// failed requests for a page, then screenshot it once its async rendering settled.
// Pass `touch` as the sixth argument to emulate a coarse pointer with no hover,
// which headless Chromium otherwise reports for every window size, so
// hover-only affordances look permanently visible in a desktop screenshot.
// Usage: node scripts/browser-check.mjs <url> [seconds] [shot.png] [width] [height] [touch|mouse]
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [url, secs = "5", shot, width = "1440", height = "900", pointer = "mouse"] =
  process.argv.slice(2);
if (!url) {
  console.error(
    "usage: node scripts/browser-check.mjs <url> [seconds] [screenshot.png] [width] [height]",
  );
  process.exit(2);
}
const port = 9333 + Math.floor(Math.random() * 500);
// Headless Chromium has no pointing device, so it reports `hover: none` and
// `pointer: coarse` at every window size and a desktop screenshot shows every
// hover-only affordance as permanently visible. Blink settings are the only
// lever that moves those media features; CDP's setEmulatedMedia does not cover
// them. Values are Blink's enums: hover none=1 hover=2, pointer coarse=2 fine=4.
const blink =
  pointer === "touch"
    ? "primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2"
    : "primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";
const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--blink-settings=${blink}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 1500));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const reqs = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
let problems = 0;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled")
    console.log(
      `console.${m.params.type}:`,
      m.params.args.map((a) => a.value ?? a.description).join(" "),
    );
  if (m.method === "Runtime.exceptionThrown") {
    problems++;
    console.log(
      "EXCEPTION:",
      m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
    );
  }
  if (m.method === "Network.requestWillBeSent") reqs.set(m.params.requestId, m.params.request.url);
  if (m.method === "Network.loadingFailed") {
    problems++;
    console.log("NETFAIL:", m.params.errorText, reqs.get(m.params.requestId));
  }
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
    problems++;
    console.log("HTTP", m.params.response.status, m.params.response.url);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Network.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 1,
  mobile: false,
});
await call("Page.navigate", { url });
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
if (shot) {
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(shot, Buffer.from(data, "base64"));
  console.log("screenshot:", shot);
}
chrome.kill();
console.log(problems ? `problems: ${problems}` : "problems: 0");
process.exit(problems ? 1 : 0);
