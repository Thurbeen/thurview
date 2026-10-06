// One headless Chromium per suite, on a DevTools port it picks itself, so two
// browser suites running side by side can never race for the same port.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";

export const browserBin =
  process.env["CHROMIUM"] ??
  ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
    .flatMap((b) => (process.env["PATH"] ?? "").split(delimiter).map((d) => join(d, b)))
    .find((p) => existsSync(p));

export interface Browser {
  devtools: number;
  close(): Promise<void>;
}

/** Start the browser with `profile` as its data dir and wait until DevTools answers. */
export async function launchBrowser(profile: string, timeoutMs = 60_000): Promise<Browser> {
  const proc: ChildProcess = spawn(
    browserBin!,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const close = async () => {
    // Chromium keeps writing its profile until it has exited, so a caller
    // removes the profile only after this resolves.
    if (proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = Number(
      (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0],
    );
    if (
      port &&
      (await fetch(`http://127.0.0.1:${port}/json/version`).then(
        () => true,
        () => false,
      ))
    )
      return { devtools: port, close };
    await new Promise((r) => setTimeout(r, 100));
  }
  await close();
  throw new Error(`the browser's DevTools did not answer within ${timeoutMs}ms`);
}
