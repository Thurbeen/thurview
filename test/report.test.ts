// A review sealed with its pass reads as a report: what changed first, then the
// verdict, the findings with their diff lines one step away, the risks and the
// scope. Published with `publish --pass`, carried by the served page and by an
// exported copy opened from disk with no server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { browserBin, launchBrowser, type Browser } from "./browser.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const DEMO = join(ROOT, "scripts", "demo");

let tmp: string;
let home: string;
let repo: string;
let head: string;
let reviewId: string;
let reviewDir: string;
let exported: string;

async function cli(args: string[], expectCode = 0) {
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd: repo, env: { ...process.env, THURVIEW_HOME: home } },
    );
    expect(expectCode).toBe(0);
    return decode(stdout.trim()) as Record<string, any>;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (typeof err.code !== "number") throw e;
    expect(err.code, err.stdout).toBe(expectCode);
    return decode(String(err.stdout).trim()) as Record<string, any>;
  }
}

async function writePass(file: string, patch: Record<string, unknown> = {}) {
  const pass = JSON.parse(await readFile(join(DEMO, "review", "pass.json"), "utf8"));
  await writeFile(file, JSON.stringify({ ...pass, head, ...patch }));
}

beforeAll(async () => {
  await execFileP(process.execPath, ["scripts/build-ui.mjs"], { cwd: ROOT });
  tmp = await mkdtemp(join(tmpdir(), "thurview-report-"));
  home = join(tmp, "home");
  repo = join(tmp, "repo");
  await execFileP("bash", [join(DEMO, "make-repo.sh"), repo]);
  head = (await execFileP("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const { review } = await cli(["scaffold", "--title", "Audit every login"]);
  reviewId = review.uuid;
  reviewDir = review.dir;
  for (const f of ["review.md", "data.yaml", "map.yaml"])
    await cp(join(DEMO, "review", f), join(reviewDir, f));
}, 120_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe("publish --pass", () => {
  it("refuses a pass for another head, and seals nothing", async () => {
    const file = join(tmp, "stale.json");
    await writePass(file, { head: "0123456789abcdef0123456789abcdef01234567" });
    const out = await cli(["publish", "--review", reviewId, "--pass", file], 2);
    expect(out["code"]).toBe("VALIDATION_ERROR");
    expect(String(out["error"])).toContain(head.slice(0, 12));
    process.env["THURVIEW_HOME"] = home;
    const { readReview } = await import("../src/store.ts");
    expect((await readReview(reviewId))!.revision).toBe(0);
  });

  it("refuses a pass that is not one", async () => {
    const file = join(tmp, "bad.json");
    await writePass(file, { confidence: 9 });
    const out = await cli(["publish", "--review", reviewId, "--pass", file], 2);
    expect(out["code"]).toBe("VALIDATION_ERROR");
    expect(String(out["error"])).toContain("confidence");
  });

  it("refuses a pass on an explainer, which has no verdict to show", async () => {
    const { explainer } = await cli(["explain", "src"]);
    await cp(join(DEMO, "review", "review.md"), join(explainer.dir, "review.md"));
    await cp(join(DEMO, "review", "data.yaml"), join(explainer.dir, "data.yaml"));
    const file = join(tmp, "explainer-pass.json");
    await writePass(file);
    const out = await cli(["publish", "--review", explainer.uuid, "--pass", file], 2);
    expect(out["code"]).toBe("VALIDATION_ERROR");
    expect(String(out["error"])).toContain("explainer");
  });

  it("seals the pass with the revision as its verdict, and the page receives it", async () => {
    const file = join(tmp, "pass.json");
    await writePass(file);
    const out = await cli(["publish", "--review", reviewId, "--pass", file]);
    expect(out["published"]["rev"]).toBe(1);
    expect(String(out["published"]["verdict"])).toContain("confidence 4/5");
    const { revisionData } = await import("../src/server/server.ts");
    const { readReview } = await import("../src/store.ts");
    const data = await revisionData((await readReview(reviewId))!, 1);
    const pass = data.verdict as Record<string, any>;
    expect(pass["head"]).toBe(head);
    expect(pass["confidence"]).toBe(4);
    expect(pass["findings"]).toHaveLength(4);
    expect(pass["ran"][0]["kind"]).toBe("search");
    // what only the forge needs stays off the page
    expect(pass).not.toHaveProperty("reviewUrl");
    expect(pass).not.toHaveProperty("assessments");
  });

  it("leaves a revision published without one with no pass", async () => {
    await cli(["publish", "--review", reviewId]);
    const { revisionData } = await import("../src/server/server.ts");
    const { readReview } = await import("../src/store.ts");
    expect((await revisionData((await readReview(reviewId))!, 2)).verdict).toBeNull();
    // and the report under test is the one with the verdict
    const file = join(tmp, "pass.json");
    await cli(["publish", "--review", reviewId, "--pass", file]);
    exported = join(tmp, "out", "report.html");
    await cli(["export", "--review", reviewId, "--out", exported, "--no-threads"]);
  });
});

describe.skipIf(!browserBin)("the exported report in a browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser(join(tmp, "profile"));
  }, 90_000);
  afterAll(() => browser?.close(), 30_000);

  async function open(width: number) {
    const target = (await (
      await fetch(`http://127.0.0.1:${browser.devtools}/json/new?about:blank`, { method: "PUT" })
    ).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    const errors: string[] = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) pending.get(m.id)!(m.result ?? m.error);
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
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: pathToFileURL(exported).href });
    const until = (cond: string) =>
      evaluate(`new Promise((ok, no) => {
        const t = Date.now();
        (function wait() {
          if (${cond}) return ok(true);
          if (Date.now() - t > 15000) return no(new Error("never: " + ${JSON.stringify(cond)}));
          setTimeout(wait, 100);
        })();
      })`);
    await until(`document.querySelector(".report-verdict")`);
    return { evaluate, until, errors, close: () => ws.close() };
  }

  it("opens on what changed, then the verdict, the findings, the risks and the scope", async () => {
    const p = await open(1440);
    try {
      const order = await p.evaluate<string[]>(
        `[...document.querySelectorAll(".report > section")].map(s => s.id)`,
      );
      expect(order.slice(0, 5)).toEqual([
        "report-summary",
        "report-verdict",
        "report-findings",
        "report-risks",
        "report-scope",
      ]);
      const text = await p.evaluate<string>("document.body.innerText");
      expect(text).toContain("login() and logout() append one JSON line per event");
      expect(text).toContain("Not yet: non-blocking findings are worth a look before merge.");
      expect(text).toContain("Concurrent logins can exceed the cap.");
      expect(text).toContain("The cap is read and written without a lock");
      expect(text).toContain("Trust boundaries");
      expect(text).toContain("the repository has no tests");
      // most severe first: the nit is last
      const sev = await p.evaluate<string[]>(
        `[...document.querySelectorAll(".finding .sev")].map(s => s.textContent)`,
      );
      expect(sev.at(-1)).toBe("nit");
      expect(p.errors).toEqual([]);
    } finally {
      p.close();
    }
  }, 60_000);

  it("shows a finding's diff lines and its fix one step away", async () => {
    const p = await open(1440);
    try {
      await p.evaluate(`document.querySelector(".finding button.finding-row").click()`);
      await p.until(`document.querySelector(".finding-evidence tr.mark")`);
      const ev = await p.evaluate<string>(`document.querySelector(".finding-evidence").innerText`);
      expect(ev).toContain("sessions.filter((s) => s.user === user).length >= MAX_SESSIONS");
      expect(ev).toContain("Serialize login per user");
    } finally {
      p.close();
    }
  }, 60_000);

  it("fits a phone: no sideways scroll, and a finding opens in place", async () => {
    const p = await open(390);
    try {
      expect(await p.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      await p.evaluate(`document.querySelector(".finding button.finding-row").click()`);
      await p.until(`document.querySelector(".finding .finding-evidence tr.mark")`);
      // what scrolls inside its own box (code, a diagram, a table) may be wider
      const wide = await p.evaluate<number>(
        `[...document.querySelectorAll(".report *")].filter(e => !e.closest(".code, .seq-scroll, .cov, pre") && e.getBoundingClientRect().right > innerWidth + 1).length`,
      );
      expect(wide).toBe(0);
    } finally {
      p.close();
    }
  }, 60_000);
});
