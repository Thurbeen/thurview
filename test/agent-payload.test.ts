// What an agent reads on every pass of thurview-pr-review: the instructions the
// skill sends it to, and what `pr-review status` prints. Both are paid for on
// every push of every change request, so each must carry what the pass needs
// once, and leave what only some passes need to an explicit drill-down.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const SKILL = join(ROOT, "skills", "thurview-pr-review");
const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const OLD = "cccc3333cccc3333cccc3333cccc3333cccc3333";

/** The references step 4 sends the agent to on every pass, and the ones it reads on demand. */
async function perPassReading(): Promise<{ always: string[]; bytes: number }> {
  const skill = await readFile(join(SKILL, "SKILL.md"), "utf8");
  const step4 = skill.split("## 4.")[1]!.split("## 5.")[0]!;
  const always = step4
    .split(/\n\n/)
    .filter((p) => /Read the shared authoring contracts/.test(p))
    .flatMap((p) => [...p.matchAll(/\]\((\.\.\/thurview\/references\/[\w-]+\.md)\)/g)])
    .map((m) => m[1]!);
  // step 2 sends every pass to these two as well
  always.push("../thurview/references/architecture.md", "../thurview/references/searching.md");
  const unique = [...new Set(always)];
  let bytes = Buffer.byteLength(skill);
  for (const ref of unique) bytes += Buffer.byteLength(await readFile(join(SKILL, ref), "utf8"));
  return { always: unique, bytes };
}

describe("the instructions a pass reads", () => {
  it("reads the diagram and map references only when the page draws one", async () => {
    const { always } = await perPassReading();
    expect(always).toContain("../thurview/references/document-authoring.md");
    expect(always).toContain("../thurview/references/components.md");
    expect(always).not.toContain("../thurview/references/diagrams.md");
    expect(always).not.toContain("../thurview/references/software-map.md");
    const skill = await readFile(join(SKILL, "SKILL.md"), "utf8");
    expect(skill).toMatch(
      /\[Diagrams\]\(\.\.\/thurview\/references\/diagrams\.md\)[^\n]*\n?[^\n]*only/,
    );
  });

  it("keeps what every pass reads under its byte budget", async () => {
    // A proxy for tokens: 65,457 bytes before the diagram and map references
    // moved to on demand. The budget is what is left, with room for one edit.
    const { bytes } = await perPassReading();
    expect(bytes).toBeLessThan(57_000);
  });

  it("does not have status reprint the category and confidence tables the skill holds", async () => {
    const skill = await readFile(join(SKILL, "SKILL.md"), "utf8");
    expect(skill).not.toMatch(/It also prints the categories and confidence scale/);
  });
});

describe("pr-review status", { timeout: 60_000 }, () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let repo: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thurview-payload-"));
    repo = join(dir, "repo");
    const bin = join(dir, "bin");
    await exec("mkdir", ["-p", repo, bin, join(dir, "home")]);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["remote", "add", "origin", "git@github.com:acme/web.git"], { cwd: repo });
    env = {
      ...process.env,
      THURVIEW_HOME: join(dir, "home"),
      PATH: `${bin}:${process.env["PATH"]}`,
      FORGE_RESPONSES: join(dir, "responses.json"),
      FORGE_LOG: join(dir, "calls.jsonl"),
      GH_HOST: "",
    };
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test", "fake-forge.mjs")}" gh "$@"\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    // twelve findings of this review's, a third of them resolved on the forge
    const own = Array.from({ length: 12 }, (_, i) => ({
      id: `PRRT_${i}`,
      isResolved: i % 3 === 0,
      isOutdated: false,
      path: "src/auth.ts",
      line: 5 + i,
      diffSide: "RIGHT",
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "bot" },
            body: `<!-- thurview-finding {"id":"f${i}","category":"reliability","severity":"non-blocking"} -->\n**Reliability · non-blocking:** Finding ${i} about the cap.`,
            url: `https://github.com/acme/web/pull/7#discussion_r${i}`,
            originalCommit: { oid: OLD },
          },
        ],
      },
    }));
    await writeFile(
      env["FORGE_RESPONSES"]!,
      JSON.stringify([
        {
          cli: "gh",
          match: ["issues/7/comments", "--paginate"],
          body: [
            [
              {
                id: 9,
                user: { login: "bot" },
                body: `<!-- thurview-pr-review {"head":"${OLD}","state":"active","seen":"5"} -->\nNext: @dev\n\nrest`,
              },
            ],
          ],
        },
        {
          cli: "gh",
          match: ["graphql"],
          body: {
            data: {
              repository: {
                pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: own } },
              },
            },
          },
        },
        {
          cli: "gh",
          match: ["repos/acme/web/pulls/7"],
          body: {
            number: 7,
            title: "Cap sessions",
            html_url: "https://github.com/acme/web/pull/7",
            body: "",
            draft: false,
            state: "open",
            merged: false,
            user: { login: "dev" },
            labels: [],
            head: { sha: HEAD, ref: "cap", repo: { full_name: "acme/web" } },
            base: { sha: OLD, ref: "main", repo: { full_name: "acme/web" } },
          },
        },
        { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
      ]),
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function status(...extra: string[]): Promise<{ text: string; out: Record<string, any> }> {
    const { stdout } = await exec(
      process.execPath,
      [
        join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        join(ROOT, "src", "main.ts"),
        "pr-review",
        "status",
        "--change",
        "7",
        ...extra,
      ],
      { cwd: repo, env },
    );
    return { text: stdout, out: decode(stdout.trim()) as Record<string, any> };
  }

  it("prints each of this review's findings once, and every one to reassess", async () => {
    const { text, out } = await status();
    // every own finding is in reassess, open or resolved, with its thread
    expect(out["reassess"]).toHaveLength(12);
    expect(out["reassess"][0]).toMatchObject({ id: "f0", open: false, thread: "PRRT_0" });
    // the open ones keep their row, for the callers that read it
    expect(out["open"]).toHaveLength(8);
    expect(out["open"][0]).toMatchObject({ id: "f1", category: "reliability" });
    // and no title is printed twice
    for (let i = 0; i < 12; i++)
      expect(text.split(`Finding ${i} about the cap.`).length - 1, `f${i}`).toBe(1);
  });

  it("leaves the category and confidence tables to the skill unless asked for them", async () => {
    const { out } = await status();
    expect(out).not.toHaveProperty("categories");
    expect(out).not.toHaveProperty("confidence");
    const full = (await status("--full")).out;
    expect(Object.keys(full["categories"])).toContain("architecture");
    expect(full["confidence"]["5"]).toMatch(/Safe to merge/);
  });
});
