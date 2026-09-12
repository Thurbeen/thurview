import { AxiError } from "axi-sdk-js";
import { runJson, ok } from "./run.js";
import { parseRemote } from "./github.js";
import type {
  Check,
  CheckState,
  ChangeRequest,
  Forge,
  PriorPass,
  PriorThread,
  RepoId,
  Submission,
  SubmitResult,
} from "./types.js";

/**
 * GitLab, through `glab api`. Every parameter goes through `--raw-field`, the
 * literal-string flag, so a comment body starting with `@` is sent as text
 * rather than read as a file path.
 * Three things differ from GitHub beyond the
 * nouns, and each one is answered here rather than papered over:
 *
 *   - There is no atomic review. A pass is N discussions plus one note, so a
 *     failure part-way through leaves the comments already posted. `submit`
 *     posts the inline comments first and the summary last, so a partial pass
 *     is one the author can still read.
 *   - There is no CHANGES_REQUESTED. `request-changes` removes this account's
 *     approval and says so in the summary note; it cannot block a merge the
 *     way GitHub's state does, and `notes` says that out loud.
 *   - A comment anchors to one line. A range is anchored at its last line and
 *     reported in `notes`; the range itself belongs in the comment's own
 *     permalink.
 */

/**
 * Job statuses, mapped once and here. `manual` is a job that exists and has
 * not run, which is the exact case a "no failures" reading gets wrong.
 */
const JOB: Record<string, CheckState> = {
  success: "passed",
  failed: "failed",
  canceled: "cancelled",
  cancelled: "cancelled",
  skipped: "skipped",
  manual: "skipped",
  running: "running",
  pending: "running",
  created: "running",
  preparing: "running",
  waiting_for_resource: "running",
  scheduled: "running",
};

interface RestMr {
  iid: number;
  title: string;
  web_url: string;
  description: string | null;
  draft?: boolean;
  work_in_progress?: boolean;
  state: string;
  author: { username: string } | null;
  sha: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
}

interface Pipeline {
  id: number;
  project_id: number;
}

interface Job {
  name: string;
  status: string;
  web_url?: string;
}

interface Discussion {
  id: string;
  notes: {
    id: number;
    body: string;
    system: boolean;
    resolvable: boolean;
    resolved?: boolean;
    author: { username: string } | null;
    position?: {
      new_path?: string;
      old_path?: string;
      new_line?: number | null;
      old_line?: number | null;
      head_sha?: string;
    } | null;
  }[];
}

function iidOf(ref: string): string {
  const m = /^(?:.*\/merge_requests\/)?!?(\d+)\/?$/.exec(ref.trim());
  if (!m)
    throw new AxiError(`${ref} is not a merge request number or URL`, "VALIDATION_ERROR", [
      "Pass --change 123 or the full merge request URL",
    ]);
  return m[1]!;
}

export class GitLabForge implements Forge {
  readonly id = "gitlab";
  readonly cli = "glab";

  private api(repo: RepoId, endpoint: string, args: string[] = []): string[] {
    return ["api", "--hostname", repo.host, endpoint, ...args];
  }

  private project(repo: RepoId): string {
    return encodeURIComponent(repo.path);
  }

  async owns(host: string): Promise<boolean> {
    if (host === "gitlab.com" || host === process.env["GITLAB_HOST"]) return true;
    return ok("glab", ["auth", "status", "--hostname", host]);
  }

  async whoami(repo: RepoId): Promise<string> {
    const me = await runJson<{ username: string }>("glab", this.api(repo, "user"));
    return me.username;
  }

  repoFromRemote(url: string): RepoId | null {
    return parseRemote(url);
  }

  async get(repo: RepoId, ref: string): Promise<ChangeRequest> {
    const iid = iidOf(ref);
    const mr = await runJson<RestMr>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${iid}`),
    );
    return {
      number: String(mr.iid),
      title: mr.title,
      url: mr.web_url,
      state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
      author: mr.author?.username ?? "unknown",
      head: mr.diff_refs?.head_sha ?? mr.sha,
      headBranch: mr.source_branch,
      base: mr.diff_refs?.base_sha ?? "",
      baseBranch: mr.target_branch,
      fromFork: mr.source_project_id !== mr.target_project_id,
      draft: Boolean(mr.draft ?? mr.work_in_progress),
      body: mr.description ?? "",
    };
  }

  fetchRef(cr: ChangeRequest): string {
    return `refs/merge-requests/${cr.number}/head`;
  }

  async checks(repo: RepoId, cr: ChangeRequest): Promise<Check[]> {
    const pipelines = await runJson<Pipeline[]>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/pipelines`),
    );
    return this.jobsOf(repo, pipelines[0]);
  }

  async baseline(repo: RepoId, branch: string): Promise<Check[]> {
    const pipelines = await runJson<Pipeline[]>(
      "glab",
      this.api(
        repo,
        `projects/${this.project(repo)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`,
      ),
    );
    return this.jobsOf(repo, pipelines[0]);
  }

  /** Jobs live in the pipeline's own project, which for a fork is not `repo`. */
  private async jobsOf(repo: RepoId, pipeline: Pipeline | undefined): Promise<Check[]> {
    if (!pipeline) return [];
    const jobs = await runJson<Job[]>(
      "glab",
      this.api(repo, `projects/${pipeline.project_id}/pipelines/${pipeline.id}/jobs?per_page=100`),
    );
    return jobs.map((j) => ({
      name: j.name,
      state: JOB[j.status] ?? "unknown",
      raw: j.status,
      ...(j.web_url ? { url: j.web_url } : {}),
    }));
  }

  async prior(
    repo: RepoId,
    cr: ChangeRequest,
  ): Promise<{ passes: PriorPass[]; threads: PriorThread[] }> {
    const discussions = await runJson<Discussion[]>(
      "glab",
      this.api(
        repo,
        `projects/${this.project(repo)}/merge_requests/${cr.number}/discussions?per_page=100`,
      ),
    );
    const threads: PriorThread[] = [];
    const passes: PriorPass[] = [];
    for (const d of discussions) {
      const notes = d.notes.filter((n) => !n.system);
      const first = notes[0];
      if (!first) continue;
      // A discussion with no position and no resolvable flag is a plain note
      // on the merge request, which is what a summary pass looks like here.
      if (!first.position && !first.resolvable) {
        passes.push({
          id: d.id,
          author: first.author?.username ?? "unknown",
          verdict: "comment",
          at: "",
          body: first.body,
        });
        continue;
      }
      threads.push({
        id: d.id,
        author: first.author?.username ?? "unknown",
        ...(first.position?.new_path ? { path: first.position.new_path } : {}),
        ...(first.position?.new_line ? { line: first.position.new_line } : {}),
        side: first.position?.new_line ? ("head" as const) : ("base" as const),
        resolved:
          notes.some((n) => n.resolvable) && notes.every((n) => !n.resolvable || n.resolved),
        // GitLab reports no per-comment staleness; the head it was written
        // against is the only signal, and `prior` compares it in the CLI.
        outdated: false,
        ...(first.position?.head_sha ? { commit: first.position.head_sha } : {}),
        messages: notes.map((n) => ({ author: n.author?.username ?? "unknown", body: n.body })),
      });
    }
    const approvals = await runJson<{ approved_by?: { user: { username: string } }[] }>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/approvals`),
    );
    for (const a of approvals.approved_by ?? [])
      passes.push({
        id: `approval:${a.user.username}`,
        author: a.user.username,
        verdict: "approve",
        at: "",
        body: "",
      });
    return { passes, threads };
  }

  async submit(repo: RepoId, cr: ChangeRequest, s: Submission): Promise<SubmitResult> {
    const mr = await runJson<RestMr>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}`),
    );
    const refs = mr.diff_refs;
    if (!refs && s.comments.length)
      throw new AxiError("this merge request reports no diff refs", "FORGE_ERROR", [
        "Post the summary alone with an empty comments array, or retry once the merge request has a diff",
      ]);
    const notes: string[] = [];
    let posted = 0;
    for (const c of s.comments) {
      if (c.startLine && c.startLine < c.line)
        notes.push(`${c.path}:${c.startLine}-${c.line} anchored at line ${c.line}`);
      await runJson<unknown>(
        "glab",
        this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/discussions`, [
          "--method",
          "POST",
          "--raw-field",
          `body=${c.body}`,
          "--raw-field",
          "position[position_type]=text",
          "--raw-field",
          `position[base_sha]=${refs!.base_sha}`,
          "--raw-field",
          `position[start_sha]=${refs!.start_sha}`,
          "--raw-field",
          `position[head_sha]=${refs!.head_sha}`,
          "--raw-field",
          `position[new_path]=${c.path}`,
          "--raw-field",
          `position[old_path]=${c.path}`,
          "--raw-field",
          c.side === "base" ? `position[old_line]=${c.line}` : `position[new_line]=${c.line}`,
        ]),
      );
      posted++;
    }
    if (s.verdict === "approve") {
      await runJson<unknown>(
        "glab",
        this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/approve`, [
          "--method",
          "POST",
        ]),
      );
    } else if (s.verdict === "request-changes") {
      notes.push(
        "GitLab has no changes-requested state; this account's approval was removed and the summary says changes are requested",
      );
      await runJson<unknown>(
        "glab",
        this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/unapprove`, [
          "--method",
          "POST",
        ]),
      ).catch(() => notes.push("no approval by this account to remove"));
    }
    await runJson<unknown>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/notes`, [
        "--method",
        "POST",
        "--raw-field",
        `body=${s.body}`,
      ]),
    );
    return { verdict: s.verdict, posted, url: cr.url, notes };
  }

  async reply(
    repo: RepoId,
    cr: ChangeRequest,
    threadId: string,
    body: string | undefined,
    resolve: boolean,
  ): Promise<{ replied: boolean; resolved: boolean; notes: string[] }> {
    const base = `projects/${this.project(repo)}/merge_requests/${cr.number}/discussions/${threadId}`;
    if (body !== undefined)
      await runJson<unknown>(
        "glab",
        this.api(repo, `${base}/notes`, ["--method", "POST", "--raw-field", `body=${body}`]),
      );
    if (resolve)
      await runJson<unknown>(
        "glab",
        this.api(repo, base, ["--method", "PUT", "--raw-field", "resolved=true"]),
      );
    return { replied: body !== undefined, resolved: resolve, notes: [] };
  }

  permalink(repo: RepoId, sha: string, path: string, from?: number, to?: number): string {
    const base = `https://${repo.host}/${repo.path}/-/blob/${sha}/${path}`;
    if (!from) return base;
    return to && to > from ? `${base}#L${from}-${to}` : `${base}#L${from}`;
  }
}
