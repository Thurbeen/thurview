// A review sealed with its pass reads as a report: what changed first, then the
// verdict, the findings with their diff lines one step away, the risks and the
// scope. Published with `publish --pass`, carried by the served page and by an
// exported copy opened from disk with no server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, cp, rm } from "node:fs/promises";
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
let zero: string;
let pr: string;

async function cli(args: string[], expectCode = 0, env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd: repo, env: { ...process.env, THURVIEW_HOME: home, ...env } },
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

describe("publish --pass", { timeout: 60_000 }, () => {
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
    const clean = join(tmp, "clean.json");
    await writePass(clean, { confidence: 5, findings: [], risk: ["Only the audit path changes."] });
    await cli(["publish", "--review", reviewId, "--pass", clean]);
    zero = join(tmp, "out", "zero.html");
    await cli(["export", "--review", reviewId, "--out", zero, "--no-threads"]);
  });

  it("seals what the forge says about a pull request's author and head", async () => {
    const bin = join(tmp, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test", "fake-forge.mjs")}" gh "$@"\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const base = (await execFileP("git", ["rev-parse", "main"], { cwd: repo })).stdout.trim();
    const responses = join(tmp, "responses.json");
    await writeFile(
      responses,
      JSON.stringify([
        { cli: "gh", match: ["collaborators/dev/permission"], body: { permission: "write" } },
        {
          cli: "gh",
          match: [`repos/acme/web/commits/${head}`],
          body: { commit: { verification: { verified: true, reason: "valid" } } },
        },
        {
          cli: "gh",
          match: ["repos/acme/web/pulls/7"],
          body: {
            number: 7,
            title: "Audit every login",
            html_url: "https://github.com/acme/web/pull/7",
            body: "",
            draft: false,
            state: "open",
            merged: false,
            user: { login: "dev" },
            labels: [],
            head: { sha: head, ref: "audit-logins", repo: { full_name: "acme/web" } },
            base: { sha: base, ref: "main", repo: { full_name: "acme/web" } },
          },
        },
      ]),
    );
    const env = { PATH: `${bin}:${process.env["PATH"]}`, FORGE_RESPONSES: responses, GH_HOST: "" };
    const { review } = await cli(
      ["scaffold", "--pr", "7", "--repo", "github.com/acme/web"],
      0,
      env,
    );
    for (const f of ["review.md", "data.yaml", "map.yaml"])
      await cp(join(DEMO, "review", f), join(review.dir, f));
    const file = join(tmp, "pr-pass.json");
    await writePass(file, {
      security: "Reads no new input; audit.log is written by the process that owns sessions.json.",
    });
    await cli(["publish", "--review", review.uuid, "--pass", file], 0, env);
    pr = join(tmp, "out", "pr.html");
    await cli(["export", "--review", review.uuid, "--out", pr, "--no-threads"], 0, env);
  });
});

describe.skipIf(!browserBin)("the exported report in a browser", { timeout: 60_000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser(join(tmp, "profile"));
  }, 90_000);
  afterAll(() => browser?.close(), 30_000);

  async function open(width: number, file = exported) {
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
    await call("Page.navigate", { url: pathToFileURL(file).href });
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

  it("splits the review into parts, each answering one question, in reading order", async () => {
    const p = await open(1440);
    try {
      const parts = await p.evaluate<{ id: string; title: string }[]>(
        `[...document.querySelectorAll(".report > section")].map(s => ({ id: s.id, title: document.getElementById(s.getAttribute("aria-labelledby"))?.textContent.trim() }))`,
      );
      expect(parts).toEqual([
        { id: "report-summary", title: "Summary" },
        { id: "report-architecture", title: "Architecture" },
        { id: "report-security", title: "Security & trust" },
        { id: "report-findings", title: "Findings" },
        { id: "report-risks", title: "Risks & evidence" },
        { id: "report-document", title: "Walkthrough" },
      ]);
      const part = (id: string) =>
        p.evaluate<string>(`document.getElementById("report-${id}").innerText`);
      // the summary says what changed and the verdict on it, together
      const summary = await part("summary");
      expect(summary).toContain("login() and logout() append one JSON line per event");
      expect(summary).toContain("Not yet: non-blocking findings are worth a look before merge.");
      expect(summary).toMatch(/3 non-blocking/);
      // where the change lands, before any line of it
      const arch = await part("architecture");
      expect(arch).toContain("auditing is one new module behind audit()");
      expect(arch).toContain("Interface delta");
      // trust is stated as what was checked, and what was not, never as a blanket claim
      const sec = await part("security");
      expect(sec).toContain("Trust boundaries");
      expect(sec).toContain("not bound to a pull or merge request");
      expect(sec).not.toMatch(/\b(secure|compliant)\b/i);
      // findings are what to fix; risks are what could not be ruled out, kept apart
      const found = await part("findings");
      expect(found).toContain("Concurrent logins can exceed the cap.");
      expect(found).not.toContain("Nothing tests the cap or the denied path.");
      const risks = await part("risks");
      expect(risks).toContain("Nothing tests the cap or the denied path.");
      expect(risks).toContain("the repository has no tests");
      expect(risks).not.toContain("Concurrent logins can exceed the cap.");
      // most severe first: the nit is last
      const sev = await p.evaluate<string[]>(
        `[...document.querySelectorAll(".finding .sev")].map(s => s.textContent)`,
      );
      expect(sev.at(-1)).toBe("nit");
      // the rail names the same parts, each a link the keyboard reaches
      const toc = await p.evaluate<string[]>(
        `[...document.querySelectorAll(".toc a.l2")].map(a => a.querySelector("span").textContent)`,
      );
      expect(toc).toEqual([
        "Summary",
        "Architecture",
        "Security & trust",
        "Findings",
        "Risks & evidence",
        "Walkthrough",
      ]);
      expect(p.errors).toEqual([]);
    } finally {
      p.close();
    }
  }, 60_000);

  it("moves the focus to the part the outline jumps to, so the keyboard carries on from there", async () => {
    const p = await open(1440);
    try {
      await p.evaluate(
        `[...document.querySelectorAll(".toc a.l2")].find(a => a.textContent.startsWith("Findings")).click()`,
      );
      await p.until(`document.activeElement?.id === "report-findings"`);
      // the next Tab lands inside that part, on its first finding
      expect(
        await p.evaluate<boolean>(
          `document.activeElement.querySelector("button.finding-row") !== null`,
        ),
      ).toBe(true);
    } finally {
      p.close();
    }
  }, 60_000);

  it("says plainly when there is nothing to fix", async () => {
    const p = await open(1440, zero);
    try {
      const found = await p.evaluate<string>(
        `document.getElementById("report-findings").innerText`,
      );
      expect(found).toContain("No open findings");
      const summary = await p.evaluate<string>(
        `document.getElementById("report-summary").innerText`,
      );
      expect(summary).toContain("0 blocking");
      expect(p.errors).toEqual([]);
    } finally {
      p.close();
    }
  }, 60_000);

  it("states who wrote a pull request and what the forge verified, and that it is not a safety verdict", async () => {
    const p = await open(1440, pr);
    try {
      const sec = await p.evaluate<string>(`document.getElementById("report-security").innerText`);
      expect(sec).toContain("dev");
      expect(sec).toContain("can write to the repository");
      expect(sec).toContain("signature verified by GitHub");
      expect(sec).toContain("not whether the change is safe");
      expect(sec).toContain("Reads no new input");
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
