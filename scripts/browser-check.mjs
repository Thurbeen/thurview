// Drive headless Chromium over the DevTools protocol: print console output, exceptions and
// failed requests for a page, then screenshot it once its async rendering settled.
// Usage: node scripts/browser-check.mjs <url> [seconds] [screenshot.png] [width] [height]
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [url, secs = "5", shot, width = "1440", height = "900"] = process.argv.slice(2);
if (!url) {
  console.error(
    "usage: node scripts/browser-check.mjs <url> [seconds] [screenshot.png] [width] [height]",
  );
  process.exit(2);
}
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
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
