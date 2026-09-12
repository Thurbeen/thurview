import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

type Out = Record<string, any>;

/** The real CLI, with the fake forge CLIs ahead of anything on PATH. */
async function cli(args: string[], opts: { cwd: string; expectCode?: number } = { cwd: "" }) {
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
      { cwd: opts.cwd, env },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const want = opts.expectCode ?? 0;
      if (code !== want)
        return reject(
          new Error(`thurview ${args.join(" ")} exited ${code}, wanted ${want}\n${out}\n${err}`),
        );
      try {
        resolve(decode(out.trim()) as Out);
      } catch (e) {
        reject(new Error(`bad TOON: ${(e as Error).message}\n${out}`));
      }
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

function checkRuns(...runs: [string, string, string | null][]) {
  return {
    total_count: runs.length,
    check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })),
  };
}

const PULL = {
  number: 7,
  title: "Copy the selection to the clipboard",
  html_url: "https://github.com/acme/web/pull/7",
  body: "",
  draft: false,
  state: "open",
  merged: false,
  user: { login: "outsider" },
  head: { sha: HEAD, ref: "clipboard", repo: { full_name: "outsider/web" } },
  base: { sha: TIP, ref: "main", repo: { full_name: "acme/web" } },
};

/** One check ran on the fork's head; `main` runs four. */
const GITHUB_BASE = [
  { cli: "gh", match: ["repos/acme/web/pulls/7"], body: PULL },
  {
    cli: "gh",
    match: [`commits/${HEAD}/check-runs`],
    body: checkRuns(
      ["PR Title", "completed", "success"],
      ["Nextest", "completed", "cancelled"],
      ["Windows", "completed", "cancelled"],
    ),
  },
  { cli: "gh", match: [`commits/${HEAD}/status`], body: { statuses: [] } },
  { cli: "gh", match: ["repos/acme/web/commits/main"], body: { sha: TIP } },
  {
    cli: "gh",
    match: [`commits/${TIP}/check-runs`],
    body: checkRuns(
      ["PR Title", "completed", "success"],
      ["Nextest", "completed", "success"],
      ["Windows", "completed", "success"],
      ["Clippy", "completed", "success"],
      ["Audit", "completed", "success"],
    ),
  },
  { cli: "gh", match: [`commits/${TIP}/status`], body: { statuses: [] } },
  { cli: "gh", match: ["api", "user"], body: { login: "letur" } },
];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "thurview-forge-home-"));
  bin = await mkdtemp(join(tmpdir(), "thurview-forge-bin-"));
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
    const dir = await mkdtemp(join(tmpdir(), "thurview-forge-repo-"));
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileP("git", ["remote", "add", "origin", remote], { cwd: dir });
    await mkdir(join(dir, "src"), { recursive: true });
    return dir;
  };
  github = await mk("git@github.com:acme/web.git");
  gitlab = await mk("https://gitlab.example.com/acme/web.git");
});

beforeEach(async () => {
  await rm(log, { force: true });
});

describe("thurview forge, on GitHub", () => {
  it("counts what CI did, and refuses to read cancelled jobs as a pass", async () => {
    await fixtures(GITHUB_BASE);
    const out = await cli(["forge", "status", "--change", "7"], { cwd: github });
    expect(out["change"].fromFork).toBe(true);
    expect(out["change"].head).toBe(HEAD);
    expect(out["ci"].passed).toBe(1);
    expect(out["ci"].cancelled).toBe(2);
    expect(out["ci"].failed).toBe(0);
    expect(out["ci"].trustworthy).toBe(false);
    expect(out["ci"].verdict).toContain("cancelled");
    expect(out["ci"].verdict).toContain("main runs 5");
    expect(out["ci"].verdict).toContain("CI is not a gate here");
    expect(out["checks"].map((c: Out) => c.name)).toEqual(["Nextest", "Windows"]);
  });

  it("says CI is a real gate only when every check ran and the baseline is matched", async () => {
    await fixtures([
      ...GITHUB_BASE.filter((f) => !f.match[0]!.includes("check-runs")),
      {
        cli: "gh",
        match: [`commits/${HEAD}/check-runs`],
        body: checkRuns(["Nextest", "completed", "success"], ["Clippy", "completed", "success"]),
      },
      {
        cli: "gh",
        match: [`commits/${TIP}/check-runs`],
        body: checkRuns(["Nextest", "completed", "success"], ["Clippy", "completed", "success"]),
      },
    ]);
    const out = await cli(["forge", "status", "--change", "7"], { cwd: github });
    expect(out["ci"].trustworthy).toBe(true);
    expect(out["ci"].verdict).toContain("CI is a real gate");
    expect(out["checks"]).toBe("0 of 2 checks need attention");
  });

  it("never claims a gate when the baseline could not be read", async () => {
    await fixtures([
      ...GITHUB_BASE.filter((f) => !f.match[0]!.includes("commits/main")),
      { cli: "gh", match: ["repos/acme/web/commits/main"], fail: true },
      {
        cli: "gh",
        match: [`commits/${HEAD}/check-runs`],
        body: checkRuns(["Nextest", "completed", "success"]),
      },
    ]);
    const out = await cli(["forge", "status", "--change", "7"], { cwd: github });
    expect(out["ci"].baselineRan).toBe(null);
    expect(out["ci"].trustworthy).toBe(false);
    expect(out["ci"].verdict).toContain("could not be read");
  });

  it("reads the prior pass back with what each thread was written against", async () => {
    await fixtures([
      ...GITHUB_BASE,
      {
        cli: "gh",
        match: ["graphql", "reviewThreads"],
        body: {
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      id: "R1",
                      author: { login: "letur" },
                      state: "CHANGES_REQUESTED",
                      body: "Three things below.",
                      submittedAt: "2026-09-11T10:00:00Z",
                      commit: { oid: OLD },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "T1",
                      isResolved: false,
                      isOutdated: true,
                      path: "src/clip.rs",
                      line: 40,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            author: { login: "letur" },
                            body: "The temp file keeps mode 0644.",
                            url: "https://github.com/acme/web/pull/7#r1",
                            originalCommit: { oid: OLD },
                          },
                        ],
                      },
                    },
                    {
                      id: "T2",
                      isResolved: true,
                      isOutdated: false,
                      path: "src/clip.rs",
                      line: 12,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            author: { login: "outsider" },
                            body: "Fixed.",
                            url: "https://github.com/acme/web/pull/7#r2",
                            originalCommit: { oid: HEAD },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);
    const out = await cli(["forge", "prior", "--change", "7"], { cwd: github });
    expect(out["summary"].passes).toBe(1);
    expect(out["summary"].open).toBe(1);
    expect(out["summary"].notAtHead).toBe(1);
    expect(out["threads"][0]).toMatchObject({
      id: "T1",
      at: "src/clip.rs:40",
      resolved: false,
      atHead: false,
    });
    expect(out["passes"][0].verdict).toBe("request-changes");

    const mine = await cli(["forge", "prior", "--change", "7", "--mine"], { cwd: github });
    expect(mine["threads"].map((t: Out) => t.id)).toEqual(["T1"]);
  });

  it("posts one review with its inline comments, anchored to the pinned head", async () => {
    await fixtures([
      ...GITHUB_BASE,
      {
        cli: "gh",
        match: ["pulls/7/reviews", "--method POST"],
        body: { html_url: "https://github.com/acme/web/pull/7#pullrequestreview-1" },
      },
    ]);
    const file = join(bin, "pass.json");
    await writeFile(
      file,
      JSON.stringify({
        verdict: "request-changes",
        body: "One blocking point on the temp file.\n\n— LeTuR's agent",
        comments: [
          {
            path: "src/clip.rs",
            line: 44,
            startLine: 40,
            body: "The temp file is created 0644.\n\n— LeTuR's agent",
          },
        ],
      }),
    );
    const out = await cli(["forge", "submit", "--change", "7", "--file", file], { cwd: github });
    expect(out["submitted"].verdict).toBe("request-changes");
    expect(out["submitted"].comments).toBe(1);
    const post = (await calls()).find((c) => c.args.includes("--method"))!;
    const sent = JSON.parse(post.body);
    expect(sent.event).toBe("REQUEST_CHANGES");
    expect(sent.commit_id).toBe(HEAD);
    expect(sent.comments[0]).toMatchObject({
      path: "src/clip.rs",
      line: 44,
      start_line: 40,
      side: "RIGHT",
      start_side: "RIGHT",
    });
  });

  it("warns about a comment too long to be read, and posts nothing on a dry run", async () => {
    await fixtures(GITHUB_BASE);
    const file = join(bin, "long.json");
    await writeFile(
      file,
      JSON.stringify({
        verdict: "comment",
        body: "Summary.",
        comments: [
          {
            path: "src/clip.rs",
            line: 44,
            body: Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"),
          },
        ],
      }),
    );
    const out = await cli(["forge", "submit", "--change", "7", "--file", file, "--dry-run"], {
      cwd: github,
    });
    expect(out["warnings"][0]).toContain("12 lines (max 5)");
    expect(out["dryRun"].verdict).toBe("comment");
    expect((await calls()).some((c) => c.args.includes("--method"))).toBe(false);
  });

  it("refuses to approve without --confirm, and says what approving does", async () => {
    await fixtures(GITHUB_BASE);
    const file = join(bin, "approve.json");
    await writeFile(
      file,
      JSON.stringify({ verdict: "approve", body: "Looks right.", comments: [] }),
    );
    const out = await cli(["forge", "submit", "--change", "7", "--file", file], {
      cwd: github,
      expectCode: 2,
    });
    expect(out["error"]).toContain("--confirm");
    expect(out["help"].join(" ")).toContain("auto-merge");
    expect((await calls()).some((c) => c.args.includes("--method"))).toBe(false);
  });

  it("refuses to resolve a thread except at the head it was verified against", async () => {
    await fixtures([
      ...GITHUB_BASE,
      { cli: "gh", match: ["graphql", "resolveReviewThread"], body: {} },
      { cli: "gh", match: ["graphql", "addPullRequestReviewThreadReply"], body: {} },
    ]);
    const bare = await cli(["forge", "reply", "T1", "--change", "7", "--resolve"], {
      cwd: github,
      expectCode: 2,
    });
    expect(bare["error"]).toContain("--at");

    const stale = await cli(
      ["forge", "reply", "T1", "--change", "7", "--resolve", "--at", OLD.slice(0, 12)],
      { cwd: github, expectCode: 1 },
    );
    expect(stale["help"].join(" ")).toContain("nobody checked");
    expect((await calls()).some((c) => c.args.join(" ").includes("resolveReviewThread"))).toBe(
      false,
    );

    const done = await cli(
      [
        "forge",
        "reply",
        "T1",
        "--change",
        "7",
        "--body",
        "Verified at the current head.",
        "--resolve",
        "--at",
        HEAD.slice(0, 12),
      ],
      { cwd: github },
    );
    expect(done["thread"].resolved).toBe(true);
    expect(done["thread"].verifiedAt).toBe(HEAD);
    const made = (await calls()).map((c) => c.args.join(" "));
    expect(made.some((a) => a.includes("addPullRequestReviewThreadReply"))).toBe(true);
    expect(made.some((a) => a.includes("resolveReviewThread"))).toBe(true);
  });

  it("builds a permalink to the pinned range", async () => {
    await fixtures(GITHUB_BASE);
    const out = await cli(["forge", "status", "--change", "7"], { cwd: github });
    expect(out["permalink"]).toBe(`https://github.com/acme/web/blob/${HEAD}/<path>#L10-L20`);
  });
});

const MR = {
  iid: 7,
  title: "Copy the selection to the clipboard",
  web_url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
  description: "",
  draft: false,
  state: "opened",
  author: { username: "outsider" },
  sha: HEAD,
  source_branch: "clipboard",
  target_branch: "main",
  source_project_id: 202,
  target_project_id: 101,
  diff_refs: { base_sha: TIP, head_sha: HEAD, start_sha: TIP },
};

const GITLAB_BASE = [
  // The host is self-hosted, so which adapter owns it is discovered from the
  // machine rather than from its name - the same path a real instance takes.
  { cli: "glab", match: ["auth", "status", "gitlab.example.com"], body: "" },
  {
    cli: "glab",
    match: ["projects/acme%2Fweb/merge_requests/7", "pipelines"],
    body: [{ id: 9001, project_id: 202 }],
  },
  {
    cli: "glab",
    match: ["projects/acme%2Fweb/pipelines?ref=main"],
    body: [{ id: 9002, project_id: 101 }],
  },
  {
    cli: "glab",
    match: ["projects/202/pipelines/9001/jobs"],
    body: [
      { name: "lint", status: "success" },
      { name: "test", status: "canceled" },
      { name: "deploy", status: "manual" },
    ],
  },
  {
    cli: "glab",
    match: ["projects/101/pipelines/9002/jobs"],
    body: [
      { name: "lint", status: "success" },
      { name: "test", status: "success" },
    ],
  },
  { cli: "glab", match: ["merge_requests/7/discussions"], body: [] },
  { cli: "glab", match: ["merge_requests/7/approvals"], body: { approved_by: [] } },
  { cli: "glab", match: ["projects/acme%2Fweb/merge_requests/7"], body: MR },
  { cli: "glab", match: ["api", "user"], body: { username: "letur" } },
];

describe("thurview forge, on GitLab", () => {
  it("drives glab, and separates a cancelled job from one that never ran", async () => {
    await fixtures(GITLAB_BASE);
    const out = await cli(["forge", "status", "--change", "7"], { cwd: gitlab });
    // gh is asked whether it owns the host and says no; every API call after
    // that must be glab's.
    expect((await calls()).filter((c) => c.args[0] === "api").every((c) => c.cli === "glab")).toBe(
      true,
    );
    expect(out["change"].forge).toBe("gitlab");
    expect(out["change"].fromFork).toBe(true);
    expect(out["ci"].cancelled).toBe(1);
    expect(out["ci"].skipped).toBe(1);
    expect(out["ci"].trustworthy).toBe(false);
    // GitLab spells a line range `#L10-20`, GitHub `#L10-L20`.
    expect(out["permalink"]).toBe(
      `https://gitlab.example.com/acme/web/-/blob/${HEAD}/<path>#L10-20`,
    );
  });

  it("posts a pass as discussions plus a note, and reports what GitLab cannot do", async () => {
    await fixtures([
      ...GITLAB_BASE,
      { cli: "glab", match: ["merge_requests/7/discussions", "--method POST"], body: { id: "d1" } },
      { cli: "glab", match: ["merge_requests/7/notes", "--method POST"], body: { id: 1 } },
      { cli: "glab", match: ["merge_requests/7/unapprove"], body: {} },
    ]);
    const file = join(bin, "mr.json");
    await writeFile(
      file,
      JSON.stringify({
        verdict: "request-changes",
        body: "One blocking point.",
        comments: [{ path: "src/clip.rs", line: 44, startLine: 40, body: "0644 here." }],
      }),
    );
    const out = await cli(["forge", "submit", "--change", "7", "--file", file], { cwd: gitlab });
    expect(out["submitted"].comments).toBe(1);
    expect(out["notes"].join(" ")).toContain("anchored at line 44");
    expect(out["notes"].join(" ")).toContain("no changes-requested state");
    const made = (await calls()).map((c) => c.args.join(" "));
    expect(made.some((a) => a.includes("position[new_line]=44"))).toBe(true);
    expect(made.some((a) => a.includes("unapprove"))).toBe(true);
    expect(made.some((a) => a.includes("merge_requests/7/notes"))).toBe(true);
  });
});

describe("the forge seam itself", () => {
  it("refuses a host no forge claims rather than guessing one", async () => {
    await fixtures([]);
    const dir = await mkdtemp(join(tmpdir(), "thurview-forge-repo-"));
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileP("git", ["remote", "add", "origin", "git@codeberg.org:acme/web.git"], {
      cwd: dir,
    });
    const out = await cli(["forge", "status", "--change", "7"], { cwd: dir, expectCode: 1 });
    expect(out["error"]).toContain("no forge configured for codeberg.org");
    expect(out["help"].join(" ")).toContain("--forge");
  });

  it("rejects an unknown forge sub-command and an unknown flag with exit code 2", async () => {
    await fixtures([]);
    const sub = await cli(["forge", "merge"], { cwd: github, expectCode: 2 });
    expect(sub["error"]).toContain("unknown forge command merge");
    const flag = await cli(["forge", "status", "--nope"], { cwd: github, expectCode: 2 });
    expect(flag["error"]).toContain("unknown flag --nope");
  });

  it("rejects a submission file that is not a submission", async () => {
    await fixtures(GITHUB_BASE);
    const file = join(bin, "bad.json");
    await writeFile(file, JSON.stringify({ verdict: "merge", body: "" }));
    const out = await cli(["forge", "submit", "--change", "7", "--file", file], {
      cwd: github,
      expectCode: 2,
    });
    expect(out["error"]).toContain("verdict");
  });
});

describe("thurview scaffold --pr, through the forge seam", () => {
  it("pins a self-hosted GitLab merge request with --forge, where auto-detection can't", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thurview-forge-repo-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a: string[]) => execFileP("git", a, { cwd: dir, env: gitEnv });
    await git("init", "-q", "-b", "main");
    await git("remote", "add", "origin", "https://gitlab.example.com/acme/web.git");
    await writeFile(join(dir, "clip.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-q", "-b", "clipboard");
    await writeFile(join(dir, "clip.txt"), "head\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "copy the selection");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-q", "main");

    await fixtures([
      {
        cli: "glab",
        match: ["projects/acme%2Fweb/merge_requests/7"],
        body: { ...MR, sha: head, diff_refs: { base_sha: base, head_sha: head, start_sha: base } },
      },
    ]);
    const out = await cli(["scaffold", "--pr", "7", "--forge", "gitlab"], { cwd: dir });
    expect(out["review"].binding).toBe("MR !7");
    expect(out["review"].head).toBe(head);
    // gh is never asked whether it owns the host: --forge named the adapter outright.
    expect((await calls()).every((c) => c.cli === "glab")).toBe(true);
  });
});
