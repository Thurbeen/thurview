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
  head: HEAD,
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
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
    ]);
    const file = join(bin, "pass.json");
    await writeFile(
      file,
      JSON.stringify({
        ...PASS,
        reviewUrl: "https://reviews.example.com/r/7/",
        markdownUrl: "https://reviews.example.com/r/7/feedback.md",
      }),
    );
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
    expect(JSON.parse(summary.body).body).toContain(
      "[Markdown export](https://reviews.example.com/r/7/feedback.md)",
    );
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
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
    ]);
    const file = join(bin, "pass.json");
    await writeFile(
      file,
      JSON.stringify({
        ...PASS,
        confidence: 5,
        findings: [],
        reviewUrl: "https://reviews.example.com/r/7/",
        markdownUrl: "https://reviews.example.com/r/7/feedback.md",
      }),
    );
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["pass"].summary).toBe("edited");
    expect(
      JSON.parse(
        (await calls()).find((c) => c.args.join(" ").includes("issues/comments/9 --method PATCH"))!
          .body,
      ).body,
    ).toContain("[Full review](https://reviews.example.com/r/7/)");
    expect(
      JSON.parse(
        (await calls()).find((c) => c.args.join(" ").includes("issues/comments/9 --method PATCH"))!
          .body,
      ).body,
    ).toContain("[Markdown export](https://reviews.example.com/r/7/feedback.md)");
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
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
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
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
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
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
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
    { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
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
    await writeFile(
      file,
      JSON.stringify({
        ...PASS,
        reviewUrl: "https://reviews.example.com/r/7/",
        markdownUrl: "https://reviews.example.com/r/7/feedback.md",
      }),
    );
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
    expect(note.args.find((a) => a.startsWith("body="))).toContain(
      "[Markdown export](https://reviews.example.com/r/7/feedback.md)",
    );
  });

  it("updates both public links on the same note for the next head", async () => {
    await fixtures([
      { cli: "glab", match: ["merge_requests/7/notes/9", "PUT"], body: {} },
      {
        cli: "glab",
        match: ["merge_requests/7/notes?", "--paginate"],
        body: ndjson({ id: 9, body: SUMMARY(OLD), author: { username: "bot" } }),
      },
      ...base,
    ]);
    const file = join(bin, "pass.json");
    await writeFile(
      file,
      JSON.stringify({
        ...PASS,
        confidence: 5,
        findings: [],
        reviewUrl: "https://reviews.example.com/r/7/",
        markdownUrl: "https://reviews.example.com/r/7/feedback.md",
      }),
    );
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], gitlab);
    expect(out["pass"].summary).toBe("edited");
    const logged = await calls();
    expect(logged.some((c) => c.args.includes("POST"))).toBe(false);
    const body = logged
      .find((c) => c.args.join(" ").includes("notes/9 --method PUT"))!
      .args.find((a) => a.startsWith("body="))!;
    expect(body).toContain("[Full review](https://reviews.example.com/r/7/)");
    expect(body).toContain("[Markdown export](https://reviews.example.com/r/7/feedback.md)");
    expect(body).toContain(HEAD);
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

describe("GitLab notes and threads", { timeout: 30_000 }, () => {
  it("finds its summary after someone replied to it, and reads every page of threads", async () => {
    const thread = {
      id: "d9",
      notes: [
        {
          id: 20,
          body: '<!-- thurview-finding {"id":"loop","category":"bug","severity":"blocking"} -->\n**Bug · blocking:** Loops.',
          system: false,
          resolvable: true,
          resolved: false,
          author: { username: "bot" },
          position: { new_path: "src/upload.ts", new_line: 42, head_sha: OLD },
        },
      ],
    };
    await fixtures([
      { cli: "glab", match: ["auth", "status", "gitlab.example.com"], body: "" },
      { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
      {
        cli: "glab",
        match: ["merge_requests/7/discussions?", "--paginate", "ndjson"],
        body: ndjson(thread),
      },
      { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
      {
        cli: "glab",
        match: ["merge_requests/7/notes?", "--paginate"],
        body: ndjson({
          id: 9,
          body: SUMMARY(OLD),
          type: "DiscussionNote",
          author: { username: "bot" },
        }),
      },
      { cli: "glab", match: ["projects/acme%2Fweb/merge_requests/7"], body: MR },
    ]);
    const out = await cli(["pr-review", "status", "--change", "7"], gitlab);
    expect(out["review"].reviewedHead).toBe(OLD);
    expect(out["open"][0]).toMatchObject({ id: "loop" });
  });
});

describe("repository auto-merge opt-in", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    await writeFile(
      join(home, "publish.yaml"),
      "auto_merge:\n  method: squash\n  repositories:\n    - github.com/acme/web\n    - gitlab.example.com/acme/web\n",
    );
  });
  afterAll(async () => {
    await rm(join(home, "publish.yaml"), { force: true });
  });

  async function review(
    confidence: number,
    over: Record<string, unknown> = {},
    listed = true,
    lab = false,
    threads: unknown[] = [],
    command = "sync",
    extra: string[] = [],
    findings: unknown[] = [],
    failComment = false,
  ) {
    if (!listed)
      await writeFile(
        join(home, "publish.yaml"),
        "auto_merge:\n  method: squash\n  repositories: []\n",
      );
    await fixtures(
      lab
        ? [
            { cli: "glab", match: ["cancel_merge_when_pipeline_succeeds"], body: {} },
            { cli: "glab", match: ["merge_requests/7/merge", "PUT"], body: {} },
            { cli: "glab", match: ["merge_requests/7/notes", "POST"], body: { id: 9, body: "" } },
            { cli: "glab", match: ["merge_requests/7/notes?"], body: "" },
            { cli: "glab", match: ["merge_requests/7/discussions?"], body: [] },
            { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
            {
              cli: "glab",
              match: ["projects/acme%2Fweb/merge_requests/7"],
              body: { ...MR, ...over },
            },
            { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
            { cli: "glab", match: ["auth", "status"], body: "" },
          ]
        : [
            { cli: "gh", match: ["pulls/7/comments", "POST"], body: {}, fail: failComment },
            { cli: "gh", match: ["pr", "merge"], body: "" },
            {
              cli: "gh",
              match: ["issues/7/comments", "POST"],
              body: { id: 9, body: "", user: null },
            },
            { cli: "gh", match: ["issues/7/comments", "--paginate"], body: [[]] },
            {
              cli: "gh",
              match: ["graphql"],
              body: {
                data: {
                  repository: {
                    pullRequest: { reviews: { nodes: [] }, reviewThreads: { nodes: threads } },
                  },
                },
              },
            },
            { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL(over) },
            { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
          ],
    );
    const file = join(bin, "auto-pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, confidence, findings }));
    return cli(
      [
        "pr-review",
        command,
        "--change",
        "7",
        ...(command === "sync" ? ["--file", file] : []),
        ...extra,
      ],
      lab ? gitlab : github,
    );
  }

  it("enables native squash auto-merge at 5/5 on the reviewed head", async () => {
    const out = await review(5);
    expect(out["pass"].autoMerge).toBe("auto-merge enabled at 5/5");
    expect((await calls()).find((c) => c.args.includes("--auto"))?.args).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "github.com/acme/web",
      "--auto",
      "--squash",
      "--match-head-commit",
      HEAD,
    ]);
  });
  it("holds at 4/5 without changing forge state", async () => {
    const out = await review(4);
    expect(out["pass"].autoMerge).toBe("auto-merge held: 4/5");
    expect((await calls()).some((c) => c.args.includes("merge"))).toBe(false);
  });
  it("disables existing auto-merge after a confidence drop", async () => {
    const out = await review(4, { auto_merge: { merge_method: "squash" } });
    expect(out["pass"].autoMerge).toBe("auto-merge held: 4/5");
    expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(true);
  });
  it("leaves an unlisted repository untouched", async () => {
    const out = await review(5, { auto_merge: {} }, false);
    expect(out["pass"].autoMerge).toBe("auto-merge held: repository not listed");
    expect((await calls()).some((c) => c.args.includes("merge"))).toBe(false);
  });
  it("leaves a draft untouched", async () => {
    const out = await review(5, { draft: true });
    expect(out["pass"].autoMerge).toBe("auto-merge held: draft");
    expect((await calls()).some((c) => c.args.includes("merge"))).toBe(false);
  });
  it("uses GitLab native auto-merge with squash and a head guard", async () => {
    const out = await review(5, {}, true, true);
    expect(out["pass"].autoMerge).toBe("auto-merge enabled at 5/5");
    const call = (await calls()).find((c) => c.args.includes("auto_merge=true"));
    expect(call?.args).toContain("squash=true");
    expect(call?.args).toContain(`sha=${HEAD}`);
  });
  const thread = {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    comments: { nodes: [{ author: { login: "reviewer" }, body: "Please check this." }] },
  };
  it("holds and disables for another reviewer's unresolved thread", async () => {
    const out = await review(5, { auto_merge: {} }, true, false, [thread]);
    expect(out["pass"].autoMerge).toBe("auto-merge held: unresolved threads");
    expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(true);
  });
  it("disables on a new push before a new pass is available", async () => {
    await review(5, { auto_merge: {} }, true, false, [], "wait");
    expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(true);
  });
  it("previews without enabling auto-merge", async () => {
    const out = await review(5, {}, true, false, [], "sync", ["--dry-run"]);
    expect(out["body"]).toContain("auto-merge enabled at 5/5");
    expect((await calls()).some((c) => c.args.includes("--auto"))).toBe(false);
  });
  it("cancels GitLab auto-merge on a confidence drop", async () => {
    await review(4, { merge_when_pipeline_succeeds: true }, true, true);
    expect(
      (await calls()).some((c) => c.args.join(" ").includes("cancel_merge_when_pipeline_succeeds")),
    ).toBe(true);
  });

  it("holds for an unresolved thread beyond the first GitHub page", async () => {
    const page = (nodes: unknown[], more: boolean) => ({
      data: {
        repository: {
          pullRequest: {
            reviews: { nodes: [] },
            reviewThreads: { nodes, pageInfo: { hasNextPage: more, endCursor: "next" } },
          },
        },
      },
    });
    await fixtures([
      { cli: "gh", match: ["cursor=next"], body: page([thread], false) },
      { cli: "gh", match: ["graphql"], body: page([], true) },
      { cli: "gh", match: ["pr", "merge"], body: "" },
      { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
      { cli: "gh", match: ["issues/7/comments", "--paginate"], body: [[]] },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
    ]);
    const file = join(bin, "auto-pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, confidence: 5, findings: [] }));
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["pass"].autoMerge).toBe("auto-merge held: unresolved threads");
    expect((await calls()).some((c) => c.args.includes("--auto"))).toBe(false);
  });
  it("cancels before posting new findings even when posting fails", async () => {
    await expect(
      review(
        4,
        { auto_merge: {} },
        true,
        false,
        [],
        "sync",
        [],
        [{ ...PASS.findings[0], severity: "non-blocking" }],
        true,
      ),
    ).rejects.toThrow("fixture says this call fails");
    const logged = await calls();
    const disabled = logged.findIndex((c) => c.args.includes("--disable-auto"));
    const posted = logged.findIndex((c) => c.args.join(" ").includes("pulls/7/comments"));
    expect(disabled).toBeGreaterThanOrEqual(0);
    expect(disabled).toBeLessThan(posted);
  });

  it("cancels native auto-merge when the operator stops the review", async () => {
    await review(5, { auto_merge: {} }, true, false, [], "stop");
    expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(true);
  });
  it("holds at 5/5 with its own non-blocking finding", async () => {
    const out = await review(
      5,
      {},
      true,
      false,
      [],
      "sync",
      [],
      [{ ...PASS.findings[0], severity: "non-blocking" }],
    );
    expect(out["pass"].autoMerge).toBe("auto-merge held: open findings");
    expect((await calls()).some((c) => c.args.includes("--auto"))).toBe(false);
  });
  it("rejects an unsupported merge method before any forge mutation", async () => {
    await review(4);
    await writeFile(
      join(home, "publish.yaml"),
      "auto_merge: { method: merge, repositories: [github.com/acme/web] }\n",
    );
    await rm(log, { force: true });
    const out = await cli(
      ["pr-review", "sync", "--change", "7", "--file", join(bin, "auto-pass.json")],
      github,
      2,
    );
    expect(JSON.stringify(out)).toContain("invalid auto_merge configuration");
    expect((await calls()).some((c) => c.args.includes("POST") || c.args.includes("--auto"))).toBe(
      false,
    );
  });
  it("cancels if a stop arrives during the final safety recheck", async () => {
    await fixtures([
      { cli: "gh", match: ["pr", "merge"], body: "" },
      { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
      {
        cli: "gh",
        match: ["issues/7/comments", "--paginate"],
        sequence: [[[]], [[{ id: 12, user: { login: "dev" }, body: "/thurview stop" }]]],
      },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL({ auto_merge: {} }) },
      { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
    ]);
    const file = join(bin, "auto-pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, confidence: 5, findings: [] }));
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["pass"].autoMerge).toBe("auto-merge held: review stopped");
    expect((await calls()).some((c) => c.args.includes("--auto"))).toBe(false);
    expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(true);
  });
  it.each([
    [
      { head: { sha: TIP, ref: "retry", repo: { full_name: "acme/web" } } },
      "auto-merge held: new head awaiting review",
      true,
    ],
    [{ draft: true }, "auto-merge held: draft", false],
  ] as const)(
    "rechecks the head and draft state before enabling (%s)",
    async (change, decision, cancel) => {
      await fixtures([
        { cli: "gh", match: ["pr", "merge"], body: "" },
        { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
        { cli: "gh", match: ["issues/7/comments", "--paginate"], body: [[]] },
        { cli: "gh", match: ["graphql"], body: NO_THREADS },
        {
          cli: "gh",
          match: ["repos/acme/web/pulls/7"],
          sequence: [PULL({ auto_merge: {} }), PULL({ auto_merge: {}, ...change })],
        },
        { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
      ]);
      const file = join(bin, "auto-pass.json");
      await writeFile(file, JSON.stringify({ ...PASS, confidence: 5, findings: [] }));
      const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
      expect(out["pass"].autoMerge).toBe(decision);
      expect((await calls()).some((c) => c.args.includes("--auto"))).toBe(false);
      expect((await calls()).some((c) => c.args.includes("--disable-auto"))).toBe(cancel);
    },
  );
  it("keeps fixture responses readable while parallel CLI calls advance a sequence", async () => {
    await fixtures([
      {
        cli: "gh",
        match: ["api", "user"],
        sequence: Array.from({ length: 20 }, () => ({ login: "bot" })),
      },
      { cli: "gh", match: ["issues/7/comments", "--paginate"], body: [[]] },
      { cli: "gh", match: ["graphql"], body: NO_THREADS },
      { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
      { cli: "gh", match: ["unused"], body: "x".repeat(1_000_000) },
    ]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => cli(["pr-review", "status", "--change", "7"], github)),
    );
    expect(results.every((out) => out["change"].head === HEAD)).toBe(true);
  });
});
