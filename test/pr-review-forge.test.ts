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
    ).toContain("[**Full review**](https://reviews.example.com/r/7/)");
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
      JSON.stringify({
        ...PASS,
        confidence: 5,
        findings: [],
        assessments: [
          { id: "loop", status: "fixed", evidence: "Checked the retry test at this head." },
        ],
      }),
    );
    const out = await cli(["pr-review", "sync", "--change", "7", "--file", file], github);
    expect(out["resolved"]).toEqual(["loop"]);
    const reply = (await calls()).find((c) => c.args.join(" ").includes("ThreadReply"))!;
    expect(reply.args.join(" ")).toContain(
      `Fixed at ${HEAD}: Checked the retry test at this head.`,
    );
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
    expect(body).toContain("[**Full review**](https://reviews.example.com/r/7/)");
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

const GOLDENS = join(ROOT, "test", "fixtures", "pr-summary");
const PUBLIC_LINKS = {
  reviewUrl: "https://reviews.example.com/r/7/",
  markdownUrl: "https://reviews.example.com/r/7/feedback.md",
};

// Assert the Markdown sent by the real CLI, not only the formatter's return value.
describe("compact summary golden Markdown", { timeout: 30_000 }, () => {
  async function setup(provider: "github" | "gitlab", edited = false) {
    const url =
      provider === "github"
        ? "https://github.com/acme/web/pull/7#discussion_r101"
        : "https://gitlab.example.com/acme/web/-/merge_requests/7#note_101";
    const previous = [
      {
        id: "loop",
        title: "The retry loop never stops on a 4xx.",
        severity: "blocking",
        category: "bug",
        path: "src/upload.ts",
        line: 42,
      },
      {
        id: "keep",
        title: "Timeouts lose the upload.",
        severity: "non-blocking",
        category: "reliability",
        path: "src/timeout.ts",
        line: 8,
      },
    ];
    const marked = (f: (typeof previous)[number]) =>
      `<!-- thurview-finding ${JSON.stringify({ id: f.id, category: f.category, severity: f.severity })} -->\n**${f.category === "bug" ? "Bug" : "Reliability"} · ${f.severity}:** ${f.title}`;
    if (provider === "github") {
      await fixtures([
        { cli: "gh", match: ["pulls/7/comments", "POST"], body: { id: 101, html_url: url } },
        { cli: "gh", match: ["issues/7/comments", "POST"], body: { id: 9, body: "", user: null } },
        { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
        { cli: "gh", match: ["addPullRequestReviewThreadReply"], body: {} },
        { cli: "gh", match: ["resolveReviewThread"], body: {} },
        {
          cli: "gh",
          match: ["issues/7/comments", "--paginate"],
          body: [edited ? [{ id: 9, user: { login: "bot" }, body: SUMMARY(OLD) }] : []],
        },
        {
          cli: "gh",
          match: ["graphql"],
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviews: { nodes: [] },
                  reviewThreads: {
                    nodes: edited
                      ? previous.map((f, i) => ({
                          id: `PRRT_${f.id}`,
                          isResolved: false,
                          isOutdated: false,
                          path: f.path,
                          line: f.line,
                          diffSide: "RIGHT",
                          comments: {
                            nodes: [
                              {
                                author: { login: "bot" },
                                body: marked(f),
                                url: url.replace("101", String(201 + i)),
                                originalCommit: { oid: OLD },
                              },
                            ],
                          },
                        }))
                      : [],
                  },
                },
              },
            },
          },
        },
        { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
        { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
      ]);
    } else {
      await fixtures([
        {
          cli: "glab",
          match: ["merge_requests/7/discussions", "POST"],
          body: { id: "d101", notes: [{ id: 101 }] },
        },
        {
          cli: "glab",
          match: ["merge_requests/7/notes", "POST"],
          body: { id: 9, body: "", author: null },
        },
        { cli: "glab", match: ["merge_requests/7/notes/9", "PUT"], body: {} },
        { cli: "glab", match: ["discussions/dloop/notes", "POST"], body: {} },
        { cli: "glab", match: ["discussions/dloop", "PUT"], body: { resolved: true } },
        {
          cli: "glab",
          match: ["merge_requests/7/notes?", "--paginate"],
          body: edited ? ndjson({ id: 9, body: SUMMARY(OLD), author: { username: "bot" } }) : "",
        },
        {
          cli: "glab",
          match: ["merge_requests/7/discussions?"],
          body: edited
            ? ndjson(
                ...previous.map((f, i) => ({
                  id: `d${f.id}`,
                  notes: [
                    {
                      id: 201 + i,
                      body: marked(f),
                      system: false,
                      resolvable: true,
                      resolved: false,
                      author: { username: "bot" },
                      position: { new_path: f.path, new_line: f.line, head_sha: OLD },
                    },
                  ],
                })),
              )
            : "",
        },
        { cli: "glab", match: ["auth", "status", "gitlab.example.com"], body: "" },
        { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
        { cli: "glab", match: ["projects/acme%2Fweb/merge_requests/7"], body: MR },
        { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
      ]);
    }
  }

  async function run(provider: "github" | "gitlab", p: Record<string, unknown>, code = 0) {
    const file = join(bin, "golden-pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, ...PUBLIC_LINKS, ...p }));
    return cli(
      ["pr-review", "sync", "--change", "7", "--file", file],
      provider === "github" ? github : gitlab,
      code,
    );
  }

  async function golden(name: string, out: Out, provider: "github" | "gitlab", edited = false) {
    const sent = (await calls()).find((c) =>
      c.args
        .join(" ")
        .includes(
          provider === "github"
            ? edited
              ? "issues/comments/9 --method PATCH"
              : "issues/7/comments --method POST"
            : edited
              ? "notes/9 --method PUT"
              : "notes --method POST",
        ),
    )!;
    const body: string =
      provider === "github"
        ? JSON.parse(sent.body).body
        : sent.args.find((a) => a.startsWith("body="))!.slice(5);

    expect(body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "REVIEWED_AT") + "\n").toBe(
      await readFile(join(GOLDENS, `${name}.md`), "utf8"),
    );
    expect(
      (await calls()).filter((c) =>
        /issues\/7\/comments --method POST|merge_requests\/7\/notes --method POST/.test(
          c.args.join(" "),
        ),
      ),
    ).toHaveLength(edited ? 0 : 1);
  }

  it.each(["github", "gitlab"] as const)("first review on %s", async (provider) => {
    await setup(provider);
    const out = await run(provider, {});
    await golden(`first-${provider}`, out, provider);
  });

  it.each(["github", "gitlab"] as const)("edited pass counts on %s", async (provider) => {
    await setup(provider, true);
    const out = await run(provider, {
      findings: [
        {
          ...PASS.findings[0],
          id: "new",
          startLine: undefined,
          severity: "non-blocking",
          category: "tests",
          path: "test/upload.ts",
          line: 12,
          title: "The retry limit is untested.",
        },
      ],
      confidence: 4,
      reason: "The blocking retry bug is fixed.",
      fixed: ["loop"],
      assessments: [
        { id: "loop", status: "fixed", evidence: "The 4xx test passes at this head." },
        {
          id: "keep",
          status: "still-present",
          evidence: "The timeout test still fails at this head.",
        },
      ],
    });
    await golden(`edited-${provider}`, out, provider, true);
    expect(out.sinceLastReview).toEqual({ resolved: 1, new: 1, stillOpen: 1 });
    expect(out.pass.open).toBe(2);
  });

  it("dry run shows pending locations without inventing thread URLs", async () => {
    await setup("github");
    const file = join(bin, "golden-pass.json");
    await writeFile(file, JSON.stringify({ ...PASS, ...PUBLIC_LINKS }));
    const out = await cli(
      ["pr-review", "sync", "--change", "7", "--file", file, "--dry-run"],
      github,
    );
    expect(out.body).toContain(
      "| **Blocking · Bug:** The retry loop never stops on a 4xx. | `src/upload.ts:42` |",
    );
    expect(out.body).not.toContain("#discussion_");
    expect(out.sinceLastReview).toEqual({ resolved: 0, new: 1, stillOpen: 0 });
    expect((await calls()).some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(
      false,
    );
  });

  it("zero findings omits the table", async () => {
    await setup("github");
    const out = await run("github", {
      confidence: 5,
      findings: [],
      reason: "The upload checks pass.",
    });
    await golden("zero", out, "github");
  });

  it("many findings puts blockers first and escapes table cells", async () => {
    await setup("github");
    const findings = Array.from({ length: 12 }, (_, i) => ({
      ...PASS.findings[0],
      startLine: undefined,
      id: `f${i}`,
      line: i + 1,
      severity: i % 3 === 0 ? "nit" : i % 3 === 1 ? "non-blocking" : "blocking",
      title: `Finding ${i} uses a | pipe.`,
    }));
    const out = await run("github", { findings, reason: "Four blocking bugs." });
    await golden("many", out, "github");
  });

  it("keeps unusual file paths literal in linked code locations", async () => {
    await setup("github");
    await run("github", { findings: [{ ...PASS.findings[0], path: "src/<upload>&.ts" }] });
    const note = (await calls()).find((c) =>
      c.args.join(" ").includes("issues/7/comments --method POST"),
    )!;
    expect(JSON.parse(note.body).body).toContain("[`src/<upload>&.ts:42`]");
  });

  it("counts 120 authored prose words even in folds, independently of generated rows", async () => {
    await setup("github");
    // reason + risk + signoff consume ten words; the remaining 110 belong to change.
    const prose = {
      reason: "One blocking bug.",
      risk: ["Uploads retry on a 4xx."],
      signoff: "the agent",
      change: "word ".repeat(110).trim(),
    };
    await run("github", prose);
    await rm(log, { force: true });
    const out = await run("github", { ...prose, change: "word ".repeat(111).trim() }, 2);
    expect(out.error).toMatch(/121 words.*120-word/);
    expect((await calls()).some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(
      false,
    );
  });
});

describe("compact summary lifecycle", { timeout: 30_000 }, () => {
  it.each(["github", "gitlab"] as const)(
    "retains confidence through stop, resume, merge and close on %s",
    async (provider) => {
      const original = await readFile(
        join(ROOT, "test/fixtures/pr-summary/first-github.md"),
        "utf8",
      );
      let body = original.trimEnd();
      const content = body.split("\n").slice(2);
      for (const state of ["stopped", "active", "merged", "closed"] as const) {
        if (provider === "github") {
          await fixtures([
            { cli: "gh", match: ["issues/comments/9", "PATCH"], body: {} },
            {
              cli: "gh",
              match: ["issues/7/comments", "--paginate"],
              body: [[{ id: 9, user: { login: "bot" }, body }]],
            },
            { cli: "gh", match: ["graphql"], body: NO_THREADS },
            {
              cli: "gh",
              match: ["repos/acme/web/pulls/7"],
              body: PULL({
                state: state === "merged" || state === "closed" ? "closed" : "open",
                merged: state === "merged",
              }),
            },
            { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
          ]);
        } else {
          await fixtures([
            { cli: "glab", match: ["merge_requests/7/notes/9", "PUT"], body: {} },
            {
              cli: "glab",
              match: ["merge_requests/7/notes?", "--paginate"],
              body: ndjson({ id: 9, body, author: { username: "bot" } }),
            },
            { cli: "glab", match: ["merge_requests/7/discussions?"], body: [] },
            { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
            {
              cli: "glab",
              match: ["projects/acme%2Fweb/merge_requests/7"],
              body: { ...MR, state: state === "merged" || state === "closed" ? state : "opened" },
            },
            { cli: "glab", match: ["auth", "status", "gitlab.example.com"], body: "" },
            { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
          ]);
        }
        await rm(log, { force: true });
        const command = state === "stopped" ? "stop" : state === "active" ? "start" : "wait";
        await cli(["pr-review", command, "--change", "7"], provider === "github" ? github : gitlab);
        const edits = (await calls()).filter((c) =>
          c.args.includes(provider === "github" ? "PATCH" : "PUT"),
        );
        expect(edits).toHaveLength(1);
        body =
          provider === "github"
            ? JSON.parse(edits[0]!.body).body
            : edits[0]!.args.find((a) => a.startsWith("body="))!.slice(5);
        expect(body.split("\n")[0]).toContain(`"state":"${state}"`);
        expect(body.split("\n")[1]).toContain("**Confidence 2/5**");
        expect(body.split("\n")[1]).not.toContain("do not merge; fix");
        expect(body.match(/Confidence 2\/5/g)).toHaveLength(1);
        expect(body.split("\n").slice(2)).toEqual(content);
      }
    },
  );
});

for (const provider of ["github", "gitlab"] as const) {
  describe(`finding reassessment on ${provider}`, { timeout: 30_000 }, () => {
    async function setup(resolved = false, moved = false, previousReply?: string) {
      const body =
        '<!-- thurview-finding {"id":"loop","category":"bug","severity":"blocking"} -->\n**Bug · blocking:** Loops.';
      const other = body.replace('"loop"', '"other"');
      if (provider === "github") {
        const thread = (id: string, author: string, text: string) => ({
          id,
          isResolved: resolved,
          isOutdated: moved,
          path: "src/upload.ts",
          line: moved ? 62 : 42,
          originalLine: 42,
          diffSide: "RIGHT",
          comments: {
            nodes: [
              { author: { login: author }, body: text, originalCommit: { oid: OLD }, url: "u" },
              ...(previousReply && author === "bot"
                ? [{ author: { login: "bot" }, body: previousReply, url: "u" }]
                : []),
              { author: { login: "dev" }, body: "Please check the fix.", url: "u" },
            ],
          },
        });
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
                  pullRequest: {
                    reviews: { nodes: [] },
                    reviewThreads: {
                      nodes: [thread("PRRT_1", "bot", body), thread("PRRT_2", "someone", other)],
                    },
                  },
                },
              },
            },
          },
          { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL() },
          { cli: "gh", match: ["api", "user"], body: { login: "bot" } },
        ]);
      } else {
        const thread = (id: string, author: string, text: string) => ({
          id,
          notes: [
            {
              id: 20,
              body: text,
              system: false,
              resolvable: true,
              resolved,
              author: { username: author },
              position: { new_path: "src/upload.ts", new_line: moved ? 62 : 42, head_sha: OLD },
            },
            ...(previousReply && author === "bot"
              ? [{ id: 22, body: previousReply, system: false, author: { username: "bot" } }]
              : []),
            { id: 21, body: "Please check the fix.", system: false, author: { username: "dev" } },
          ],
        });
        await fixtures([
          { cli: "glab", match: ["discussions/d1/notes", "POST"], body: {} },
          { cli: "glab", match: ["discussions/d1", "PUT"], body: {} },
          { cli: "glab", match: ["notes/9", "PUT"], body: {} },
          { cli: "glab", match: ["auth", "status"], body: "" },
          { cli: "glab", match: ["api", "user"], body: { username: "bot" } },
          {
            cli: "glab",
            match: ["merge_requests/7/discussions?", "--paginate"],
            body: ndjson(thread("d1", "bot", body), thread("d2", "someone", other)),
          },
          { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
          {
            cli: "glab",
            match: ["merge_requests/7/notes?", "--paginate"],
            body: ndjson({ id: 9, body: SUMMARY(OLD), author: { username: "bot" } }),
          },
          { cli: "glab", match: ["projects/acme%2Fweb/merge_requests/7"], body: MR },
        ]);
      }
    }
    async function run(status: string, extra: Record<string, unknown> = {}, code = 0) {
      const file = join(bin, "pass.json");
      await writeFile(
        file,
        JSON.stringify({
          ...PASS,
          findings: [],
          confidence: status === "fixed" ? 5 : 2,
          assessments: [
            {
              id: "loop",
              status,
              evidence: "src/upload.ts:62 returns on 4xx; checked the retry test at this head.",
            },
          ],
          ...extra,
        }),
      );
      return cli(
        ["pr-review", "sync", "--change", "7", "--file", file],
        provider === "github" ? github : gitlab,
        code,
      );
    }
    function mutations(logged: Awaited<ReturnType<typeof calls>>) {
      return logged.filter(
        (c) =>
          /ThreadReply|resolveReviewThread|--method (POST|PUT)/.test(c.args.join(" ")) &&
          !c.args.join(" ").includes("notes/9"),
      );
    }
    it("fixed-then-resolved replies with code evidence before resolving", async () => {
      await setup();
      const out = await run("fixed");
      expect(out.resolved).toEqual(["loop"]);
      const changes = mutations(await calls());
      expect(changes).toHaveLength(2);
      expect(changes[0]!.args.join(" ")).toContain("src/upload.ts:62 returns on 4xx");
      expect(changes[0]!.args.join(" ")).toContain(HEAD);
      expect(changes[1]!.args.join(" ")).toMatch(/resolveReviewThread|resolved=true/);
    });
    it("retries resolution without a second evidence reply and retains counts", async () => {
      await setup();
      const table = JSON.parse(await readFile(responses, "utf8"));
      const resolve = table.find(
        (e: any) =>
          e.match.includes(provider === "github" ? "resolveReviewThread" : "discussions/d1") &&
          (provider === "github" || e.match.includes("PUT")),
      );
      resolve.fail = true;
      await fixtures(table);
      await run("fixed", {}, 1);
      const logged = await calls();
      expect(logged.some((c) => /issues\/comments\/9|notes\/9/.test(c.args.join(" ")))).toBe(false);
      const reply = mutations(logged)[0]!
        .args.find((a) => a.startsWith("body="))!
        .slice(5);
      await setup(false, false, reply);
      await rm(log, { force: true });
      const out = await run("fixed");
      expect(mutations(await calls())).toHaveLength(1);
      expect(out.sinceLastReview).toEqual({ resolved: 1, new: 0, stillOpen: 0 });
      await setup(true, false, reply);
      await rm(log, { force: true });
      const retry = await run("fixed");
      expect(mutations(await calls())).toHaveLength(0);
      expect(retry.sinceLastReview).toEqual(out.sinceLastReview);
    });
    it("retries a first pass after posting its finding but failing its summary", async () => {
      await setup();
      const table = JSON.parse(await readFile(responses, "utf8"));
      if (provider === "github") {
        table.find((e: any) =>
          e.match.includes("graphql"),
        ).body.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].originalCommit.oid =
          HEAD;
        table.find((e: any) => e.match.includes("issues/7/comments")).body = [[]];
        table.unshift({
          cli: "gh",
          match: ["issues/7/comments", "POST"],
          body: { id: 9, body: "", user: null },
        });
      } else {
        const discussions = table.find((e: any) =>
          e.match.includes("merge_requests/7/discussions?"),
        );
        discussions.body = discussions.body.replace(OLD, HEAD);
        table.find((e: any) => e.match.includes("merge_requests/7/notes?")).body = "";
        table.unshift({
          cli: "glab",
          match: ["merge_requests/7/notes", "POST"],
          body: { id: 9, body: "", author: null },
        });
      }
      await fixtures(table);
      const out = await run("still-present", {
        assessments: [],
        findings: [{ ...PASS.findings[0], id: "loop" }],
      });
      expect(out.pass.open).toBe(1);
      expect(out.sinceLastReview).toEqual({ resolved: 0, new: 1, stillOpen: 0 });
      expect(out.posted).toBe("0 (no new finding)");
      expect(
        mutations(await calls()).filter((c) =>
          /ThreadReply|discussions\/d1/.test(c.args.join(" ")),
        ),
      ).toHaveLength(0);
    });
    it("still-present-stays-open and counts the same pass", async () => {
      await setup();
      const out = await run("still-present", {});
      expect(out.pass.open).toBe(1);
      expect(out.sinceLastReview).toEqual({ resolved: 0, new: 0, stillOpen: 1 });
      expect(mutations(await calls())).toHaveLength(0);
    });
    it("moved lines match the original finding thread despite replies", async () => {
      await setup(false, true);
      const out = await run("fixed");
      expect(out.resolved).toEqual(["loop"]);
      expect(
        mutations(await calls())
          .map((c) => c.args.join(" "))
          .join("\n"),
      ).toContain(provider === "github" ? "PRRT_1" : "discussions/d1");
    });
    it("partial fix replies with what remains and leaves the thread open", async () => {
      await setup();
      const out = await run("partial", {
        assessments: [
          {
            id: "loop",
            status: "partial",
            evidence: "4xx returns now; the timeout path still retries forever.",
          },
        ],
      });
      expect(out.pass.open).toBe(1);
      const changes = mutations(await calls());
      expect(changes).toHaveLength(1);
      expect(changes[0]!.args.join(" ")).toContain("timeout path still retries forever");
    });
    it("author-resolved but still broken is flagged in the summary", async () => {
      await setup(true);
      const out = await run("still-present");
      expect(out.pass.open).toBe(1);
      const edits = (await calls()).filter((c) =>
        /issues\/comments\/9|notes\/9/.test(c.args.join(" ")),
      );
      expect(edits.map((c) => c.body || c.args.join(" ")).join("\n")).toContain(
        "Resolved on forge but still present: loop",
      );
    });
    it("threads from others are left alone even when their marker is copied", async () => {
      await setup();
      const out = await run(
        "fixed",
        {
          assessments: [{ id: "other", status: "fixed", evidence: "Checked at head." }],
          confidence: 2,
        },
        1,
      );
      expect(out.error).toContain("other");
      expect(mutations(await calls())).toHaveLength(0);
    });
    it("rejects a follow pass that omits reassessment before writing", async () => {
      await setup();
      const out = await run("fixed", { assessments: [], confidence: 2 }, 2);
      expect(out.error).toContain("loop");
      expect(mutations(await calls())).toHaveLength(0);
    });
  });
}
