// What the built CLI loads for a command that reads no pass: the schema and the
// review loop cost more to import than the command takes to run, so a light
// command must not pay for them.
import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const HEAVY = ["/zod/", "/dist/pr-review/format.js", "/dist/pr-review/follow.js"];

async function loadedBy(args: string[], cwd: string): Promise<string[]> {
  const trace = join(cwd, "modules.txt");
  await exec(
    process.execPath,
    ["--import", join(ROOT, "test/module-trace.mjs"), join(ROOT, "bin/thurview.js"), ...args],
    {
      cwd,
      env: { ...process.env, THURVIEW_HOME: join(cwd, "home"), THURVIEW_MODULE_TRACE: trace },
    },
  );
  return (await readFile(trace, "utf8")).split("\n").filter(Boolean);
}

it.each([[], ["--help"], ["skill"]])(
  "a light command (%s) loads neither the pass schema nor the review loop",
  async (...args) => {
    const cwd = await mkdtemp(join(tmpdir(), "thurview-startup-"));
    try {
      const urls = await loadedBy(args, cwd);
      expect(urls.some((u) => u.includes("/dist/cli.js"))).toBe(true);
      expect(urls.filter((u) => HEAVY.some((h) => u.includes(h)))).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
