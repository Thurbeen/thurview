import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";

const ROOT = join(import.meta.dirname, "..");
const exec = promisify(execFile);

it("runs the documented PR publication and sync without a listener or server process", async () => {
  const skill = await readFile(join(ROOT, "skills/thurview-pr-review/SKILL.md"), "utf8");
  const section = skill.split("## 4.")[1]!.split("## 5.")[0]!;
  const commands = [...section.matchAll(/^thurview (?:publish|open|serve|wait)[^\n]*$/gm)].map(
    ([line]) => line.split(" ").slice(1),
  );
  // Check before executing: a regression must never start a real shared server.
  expect(commands.flat(), "PR-review publication must not require a local server").not.toContain(
    "open",
  );
  expect(commands.flat()).not.toContain("serve");
  expect(commands.flat()).not.toContain("wait");
  expect(commands.flat()).not.toContain("--open");
  expect(skill).not.toMatch(/thurview wait --review/);
  expect(commands.map((c) => c[0])).toEqual(["publish", "publish-static"]);

  const scratch = join(ROOT, "node_modules", ".cache");
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "pr-static-"));
  try {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    const bin = join(dir, "bin");
    await Promise.all([mkdir(home), mkdir(repo), mkdir(bin)]);
    const guard = join(dir, "no-listeners.cjs");
    const attempted = join(dir, "server-attempt");
    await writeFile(
      guard,
      `
const fs = require('node:fs');
const deny = () => { fs.writeFileSync(${JSON.stringify(attempted)}, 'attempted'); throw new Error('local serving forbidden'); };
require('node:net').Server.prototype.listen = deny;
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (args?.some(a => a === 'serve')) deny();
  return spawn.call(this, command, args, options);
};
require('node:module').syncBuiltinESMExports();
`,
    );
    const env = {
      ...process.env,
      THURVIEW_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--require=${guard}`,
      FORGE_RESPONSES: join(dir, "responses.json"),
      FORGE_LOG: join(dir, "calls.jsonl"),
      GH_HOST: "",
    };
    const cli = async (args: string[]) => {
      const { stdout } = await exec(process.execPath, [join(ROOT, "bin/thurview.js"), ...args], {
        cwd: repo,
        env,
      });
      return decode(stdout.trim()) as Record<string, any>;
    };
    const git = (...args: string[]) =>
      exec(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo },
      );
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "code.ts"), "export const value = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-qb", "feature");
    await writeFile(join(repo, "code.ts"), "export const value = 2;\n");
    await git("commit", "-qam", "change");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    // A local remote avoids any network fetch while the forge identifies this repository.
    await git("remote", "add", "origin", repo);
    const pull = {
      number: 7,
      title: "Change value",
      html_url: "https://github.com/acme/web/pull/7",
      body: "",
      draft: false,
      state: "open",
      merged: false,
      user: { login: "dev" },
      labels: [],
      head: { sha: head, ref: "feature", repo: { full_name: "acme/web" } },
      base: { sha: base, ref: "main", repo: { full_name: "acme/web" } },
    };
    await writeFile(
      env.FORGE_RESPONSES,
      JSON.stringify([
        { cli: "gh", match: ["/statuses/", "POST"], body: {} },
        { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
        { cli: "gh", match: ["issues/7/comments", "--paginate"], body: [[]] },
        {
          cli: "gh",
          match: ["graphql"],
          body: {
            data: {
              repository: { pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: [] } } },
            },
          },
        },
        { cli: "gh", match: ["collaborators/dev/permission"], body: { permission: "write" } },
        {
          cli: "gh",
          match: [`repos/acme/web/commits/${head}`],
          body: { commit: { verification: { verified: true, reason: "valid" } } },
        },
        { cli: "gh", match: ["repos/acme/web/pulls/7"], body: pull },
        { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
      ]),
    );
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fake-forge.mjs")}" gh "$@"\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    await writeFile(join(bin, "wrangler"), `#!/bin/sh\nexit 0\n`);
    await chmod(join(bin, "wrangler"), 0o755);
    await writeFile(
      join(home, "cloudflare.json"),
      JSON.stringify({
        name: "test-reviews",
        publicUrl: "https://reviews.example.com",
        allowLiveLink: false,
      }),
    );
    await cli(["publish-static", "--check", "--to", "cloudflare"]);
    const scaffold = await cli(["scaffold", "--pr", "7", "--repo", "github.com/acme/web"]);
    expect(scaffold.help.join("\n")).not.toContain("--open");
    const { review } = scaffold;
    expect(review.head).toBe(head);
    await writeFile(
      join(review.dir, "review.md"),
      "# Change value\n\n[value](anchor:value) becomes two.\n",
    );
    await writeFile(
      join(review.dir, "data.yaml"),
      "anchors:\n  value: { title: value, peek: { file: code.ts, from: 1, to: 1 } }\narchitecture: { view: A constant changes where it is defined. }\n",
    );
    // The pass is written before the page is sealed, so the page carries its verdict.
    const pass = join(repo, "pass.json");
    const verdict = {
      head,
      confidence: 5,
      reason: "Checked.",
      architecture: "Fits the design: one constant changes where it is defined.",
      risk: ["Only the constant changes."],
      change: "Changes value to two.",
      findings: [],
      assessments: [],
    };
    await writeFile(pass, JSON.stringify(verdict));
    let snapshot: Record<string, any> = {};
    for (const command of commands) {
      const args = command.map((arg) => arg.replace("<id>", review.id));
      if (args[0] === "publish-static") args.push("--initialize-archive");
      const out = await cli(args);
      if (out.snapshot) snapshot = out.snapshot;
      if (out.published) expect(out.help.join("\n")).not.toMatch(/thurview (?:open|wait) /);
    }
    expect(snapshot.revision).toBe(1);
    // Who wrote the change and whether the forge verified its head is read from
    // the forge at scaffold and sealed with the revision, never typed by the agent.
    process.env["THURVIEW_HOME"] = home;
    const { revisionData } = await import("../src/server/server.ts");
    const { readReview } = await import("../src/store.ts");
    const sealed = await revisionData((await readReview(review.uuid))!, 1);
    expect(sealed.provenance).toEqual({
      head,
      author: "dev",
      access: "write",
      fork: false,
      signature: "verified",
      forge: "github",
    });
    const { createHash } = await import("node:crypto");
    const target = createHash("sha256").update("test-reviews").digest("hex");
    const assets = join(home, "static", target, "assets", new URL(snapshot.url).pathname);
    const html = await readFile(join(assets, "index.html"), "utf8");
    expect(html).toContain(head);
    expect(html).toContain("Changes value to two.");
    expect(html).not.toContain("feedback.md");
    expect(html).not.toContain("http://127.0.0.1");
    expect(existsSync(join(assets, "feedback.md"))).toBe(false);
    await writeFile(pass, JSON.stringify({ ...verdict, reviewUrl: snapshot.url }));
    expect(
      (
        await cli([
          "pr-review",
          "sync",
          "--change",
          "7",
          "--repo",
          "github.com/acme/web",
          "--file",
          pass,
        ])
      ).pass.summary,
    ).toBe("created");
    const calls = (await readFile(env.FORGE_LOG, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = calls.find((c) => c.args.includes("POST"));
    expect(JSON.parse(summary.body).body).toContain(snapshot.url);
    expect(JSON.parse(summary.body).body).not.toMatch(/Markdown export|feedback\.md/);
    expect(existsSync(attempted), "no listener or serve process was attempted").toBe(false);
    expect(existsSync(join(home, "server.json"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
