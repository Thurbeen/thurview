import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `thurview pr-review` against a fake `gh` and `glab` (test/fake-forge.mjs):
 * the adapters are driven through the real command and the calls they make
 * are read back from the log. Nothing reaches a forge.
 */

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const TIP = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const OLD = "cccc3333cccc3333cccc3333cccc3333cccc3333";

let bin: string;
let home: string;
let github: string;
let gitlab: string;
let responses: string;
let log: string;
const dirs: string[] = [];

type Out = Record<string, any>;

async function cli(args: string[], cwd: string, expectCode = 0): Promise<Out> {
  const env = {
    ...process.env,
    THURVIEW_HOME: home,
    PATH: `${bin}:${process.env["PATH"]}`,
    FORGE_RESPONSES: responses,
    FORGE_LOG: log,
    GH_HOST: "",
    GITLAB_HOST: "",
  };
  return new Promise<Out>((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd, env },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== expectCode)
        return reject(new Error(`thurview ${args.join(" ")} exited ${code}\n${out}\n${err}`));
      resolve(decode(out.trim()) as Out);
    });
  });
}

async function fixtures(table: unknown[]): Promise<void> {
  await writeFile(responses, JSON.stringify(table));
}

async function calls(): Promise<{ cli: string; args: string[]; body: string }[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const PASS = {
  confidence: 2,
  reason: "One blocking bug.",
  risk: ["Uploads retry on a 4xx."],
  change: "Retries a failed upload.",
  signoff: "— the agent",
  findings: [
    {
      category: "bug",
      severity: "blocking",
      path: "src/upload.ts",
      line: 42,
      startLine: 40,
      title: "The retry loop never stops on a 4xx.",
      body: "Return on any status below 500.",
      suggestion: "if (res.status < 500) return res;",
    },
  ],
};

const SUMMARY = (head: string) =>
  `<!-- thurview-pr-review {"head":"${head}","state":"active","seen":"5"} -->\nNext: merge\n\nrest`;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "thurview-prr-home-"));
  bin = await mkdtemp(join(tmpdir(), "thurview-prr-bin-"));
  dirs.push(home, bin);
  responses = join(bin, "responses.json");
  log = join(bin, "calls.jsonl");
  for (const name of ["gh", "glab"]) {
    const path = join(bin, name);
    await writeFile(
      path,
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test", "fake-forge.mjs")}" ${name} "$@"\n`,
    );
    await chmod(path, 0o755);
  }
  const mk = async (remote: string) => {
    const dir = await mkdtemp(join(tmpdir(), "thurview-prr-repo-"));
    dirs.push(dir);
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileP("git", ["remote", "add", "origin", remote], { cwd: dir });
    return dir;
  };
  github = await mk("git@github.com:acme/web.git");
  gitlab = await mk("https://gitlab.example.com/acme/web.git");
});

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(log, { force: true });
});

const PULL = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Retry the upload",
  html_url: "https://github.com/acme/web/pull/7",
  body: "",
  draft: false,
  state: "open",
  merged: false,
  user: { login: "dev" },
  labels: [],
  head: { sha: HEAD, ref: "retry", repo: { full_name: "acme/web" } },
  base: { sha: TIP, ref: "main", repo: { full_name: "acme/web" } },
  ...over,
});

const NO_THREADS = {
  data: { repository: { pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } },
};

// Each test spawns the CLI through tsx, which takes seconds under load.
describe("thurview pr-review, on GitHub", { timeout: 30_000 }, () => {
  it("posts each finding as its own review comment, then the one summary", async () => {
    await fixtures([
      { cli: "gh", match: ["pulls/7/comments", "POST"], body: { id: 1 } },
      { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
      { cli: "gh", match: ["issues/7/comments", "--paginate", "--slurp"], body: [[]] },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
    ]);
    const file = join(bin, "pass.json");
    await writeFile(file, JSON.stringify(PASS));
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["pass"].summary).toBe("created");
    const logged = await calls();
    const inline = logged.find((c) => c.args.join(" ").includes("pulls/7/comments"))!;
    expect(JSON.parse(inline.body)).toMatchObject({
      commit_id: HEAD,
      path: "src/upload.ts",
      line: 42,
      start_line: 40,
      side: "RIGHT",
    });
    expect(JSON.parse(inline.body).body).toContain("```suggestion\n");
    const summary = logged.find((c) => c.args.join(" ").includes("issues/7/comments --method"))!;
    expect(JSON.parse(summary.body).body).toMatch(/^<!-- thurview-pr-review /);
    // A pass never touches the change request's own state.
    expect(logged.some((c) => /pulls\/7\/(merge|reviews)/.test(c.args.join(" ")))).toBe(false);
  });

  it("edits the summary it finds instead of posting a second", async () => {
    await fixtures([
      { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
      {
        cli: "gh",
        match: ["issues/7/comments", "--paginate"],
        body: [[{ id: 9, user: { login: "bot" }, body: SUMMARY(OLD) }]],
      },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
    ]);
    const file = join(bin, "pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, confidence: 5, findings: [] }));
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["pass"].summary).toBe("edited");
    const made = (await calls()).map((c) => c.args.join(" "));
    expect(made.filter((a) => a.includes("--method POST"))).toEqual([]);
    expect(made.some((a) => a.includes("issues/comments/9 --method PATCH"))).toBe(true);
  });

  it("resolves a fixed finding's thread with a reply", async () => {
    const thread = {
      id: "PRRT_1",
      isResolved: false,
      isOutdated: true,
      path: "src/upload.ts",
      line: 42,
      diffSide: "RIGHT",
      comments: {
        nodes: [
          {
            author: { login: "bot" },
            body: '<!-- thurview-finding {"id":"loop","category":"bug","severity":"blocking"} -->\n**Bug · blocking:** Loops.',
            url: "u",
            originalCommit: { oid: OLD },
          },
        ],
      },
    };
    await fixtures([
      { cli: "gh", match: ["addPullRequestReviewThreadReply"], body: {} },
      { cli: "gh", match: ["resolveReviewThread"], body: {} },
      { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
      {
        cli: "gh",
        match: ["issues/7/comments", "--paginate"],
        body: [[{ id: 9, user: { login: "bot" }, body: SUMMARY(OLD) }]],
      },
      {
        cli: "gh",
        match: ["graphql"],
        body: {
          data: {
            repository: {
              pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: [thread] } },
            },
          },
        },
      },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
    ]);
    const status = await cli(["pr-review", "status", "--change", "7"], github);
    expect(status["open"][0]).toMatchObject({ id: "loop", category: "bug" });
    expect(status["review"].pushedSince).toBe(true);
    const file = join(bin, "pass.json");
    await writeFile(
      file,
      JSON.stringify({ ...PASS, confidence: 5, findings: [], fixed: ["loop"] }),
    );
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["resolved"]).toEqual(["loop"]);
    const reply = (await calls()).find((c) => c.args.join(" ").includes("ThreadReply"))!;
    expect(reply.args).toContain(`body=Fixed in ${HEAD.slice(0, 7)}.\n\n— the agent`);
  });

  it("ends on a merge, and says so in the summary", async () => {
    await fixtures([
      { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
      {
        cli: "gh",
        match: ["issues/7/comments", "--paginate"],
        body: [[{ id: 9, user: { login: "bot" }, body: SUMMARY(HEAD) }]],
      },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      {
        cli: "gh",
        match: ["repos/acme/web/pulls/7"],
        body: PULL({ state: "closed", merged: true }),
      },
    ]);
    const out = await cli(["pr-review", "wait", "--change", "7"], github);
    expect(out["event"].event).toBe("merged");
    const edit = (await calls()).find((c) => c.args.join(" ").includes("PATCH"))!;
    expect(JSON.parse(edit.body).body).toContain("Review ended: merged");
  });

  it("stops on the stop label", async () => {
    await fixtures([
      { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
      {
        cli: "gh",
        match: ["issues/7/comments", "--paginate"],
        body: [[{ id: 9, user: { login: "bot" }, body: SUMMARY(HEAD) }]],
      },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      {
        cli: "gh",
        match: ["repos/acme/web/pulls/7"],
        body: PULL({ labels: [{ name: "thurview:stop" }] }),
      },
    ]);
    const out = await cli(["pr-review", "wait", "--change", "7"], github);
    expect(out["event"].event).toBe("stopped");
    const edit = (await calls()).find((c) => c.args.join(" ").includes("PATCH"))!;
    expect(JSON.parse(edit.body).body).toContain("Review stopped");
  });
});

const MR = {
  iid: 7,
  title: "Retry the upload",
  web_url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
  description: "",
  draft: false,
  state: "opened",
  author: { username: "dev" },
  labels: [],
  sha: HEAD,
  source_branch: "retry",
  target_branch: "main",
  source_project_id: 101,
  target_project_id: 101,
  diff_refs: { base_sha: TIP, head_sha: HEAD, start_sha: TIP },
};

const ndjson = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("thurview pr-review, on a self-hosted GitLab", { timeout: 30_000 }, () => {
  const base = [
    { cli: "glab", match: ["auth", "status", "gitlab.example.com"], body: "" },
    { cli: "glab", match: ["merge_requests/7/discussions?"], body: [] },
    { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
    { cli: "glab", match: ["projects/acme%2Fweb/merge_requests/7"], body: MR },
  ];

  it("opens a diff discussion per finding and posts the summary as a note", async () => {
    await fixtures([
      { cli: "glab", match: ["merge_requests/7/discussions", "POST"], body: { id: "d1" } },
      { cli: "glab", match: ["merge_requests/7/notes", "POST"], body: { id: 3, body: "" } },
      {
        cli: "glab",
        match: ["merge_requests/7/notes?", "--paginate", "ndjson"],
        body: ndjson(
          { id: 1, body: "joined", system: true, author: null },
          { id: 2, body: "on a line", type: "DiffNote", author: null },
        ),
      },
      ...base,
    ]);
    const file = join(bin, "pass.json");
    await writeFile(file, JSON.stringify(PASS));
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], gitlab);
    expect(out["pass"].summary).toBe("created");
    const logged = await calls();
    const discussion = logged.find((c) => c.args.join(" ").includes("discussions --method"))!;
    const sent = JSON.parse(discussion.body);
    expect(sent.position).toMatchObject({
      new_path: "src/upload.ts",
      new_line: 42,
      head_sha: HEAD,
    });
    // GitLab anchors the last line, so the suggestion reaches back over the range.
    expect(sent.body).toContain("```suggestion:-2+0\n");
    const note = logged.find((c) => c.args.join(" ").includes("notes --method POST"))!;
    expect(note.args.find((a) => a.startsWith("body="))).toMatch(/^body=<!-- thurview-pr-review /);
  });

  it("edits its note in place, and stops on a /thurview stop note", async () => {
    await fixtures([
      { cli: "glab", match: ["merge_requests/7/notes/9", "PUT"], body: {} },
      {
        cli: "glab",
        match: ["merge_requests/7/notes?", "--paginate"],
        body: ndjson(
          { id: 9, body: SUMMARY(HEAD), author: { username: "bot" } },
          { id: 12, body: "/thurview stop", author: { username: "maintainer" } },
        ),
      },
      ...base,
    ]);
    const out = await cli(["pr-review", "wait", "--change", "7"], gitlab);
    expect(out["event"]).toMatchObject({ event: "stopped" });
    expect(out["event"].why).toContain("@maintainer");
    const put = (await calls()).find((c) => c.args.join(" ").includes("notes/9 --method PUT"))!;
    const body = put.args.find((a) => a.startsWith("body="))!;
    expect(body).toContain('"state":"stopped"');
    expect(body).toContain('"seen":"12"');
  });
});
