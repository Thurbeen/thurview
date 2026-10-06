import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grepAt } from "../src/git.ts";

let repo: string;
let head: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "thurview-grep-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...a], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).toString();
  git("init", "-q");
  await mkdir(join(repo, "test", "unit"), { recursive: true });
  await writeFile(join(repo, "café.ts"), "audit(1)\naudit(2)\n");
  await writeFile(join(repo, "test", "unit", "a.test.ts"), "audit(3)\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  head = git("rev-parse", "HEAD").trim();
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("grepAt", () => {
  it("names a matched file as git stores it, however unusual the name", async () => {
    const out = await grepAt(repo, head, "audit\\(", []);
    expect(out).toEqual({ files: ["café.ts", "test/unit/a.test.ts"], hits: 3 });
  });

  it("reads paths the way the agent's own git grep does, so `*` crosses directories", async () => {
    const out = await grepAt(repo, head, "audit\\(", ["*test*"]);
    expect(out.files).toEqual(["test/unit/a.test.ts"]);
  });

  it("answers no match with nothing, not an error", async () => {
    expect(await grepAt(repo, head, "nothing here", [])).toEqual({ files: [], hits: 0 });
  });
});
