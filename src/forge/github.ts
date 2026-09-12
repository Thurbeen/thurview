import { AxiError } from "axi-sdk-js";
import { run, runJson, ok } from "./run.js";
import type {
  Check,
  CheckState,
  ChangeRequest,
  Forge,
  InlineComment,
  PriorPass,
  PriorThread,
  RepoId,
  Submission,
  SubmitResult,
} from "./types.js";

/**
 * GitHub, through `gh`. Everything goes through `gh api` rather than the
 * porcelain: `gh pr view` answers a different question per version, and the
 * REST and GraphQL payloads are the contract this adapter is written against.
 */

/**
 * Check-run conclusions, mapped once and here. `neutral` is a run that
 * reached no verdict, which is closer to skipped than to passed; `stale` is a
 * result GitHub itself no longer trusts, so it is unknown rather than either.
 */
const CONCLUSION: Record<string, CheckState> = {
  success: "passed",
  failure: "failed",
  timed_out: "failed",
  startup_failure: "failed",
  action_required: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  neutral: "skipped",
  stale: "unknown",
};

const STATUS_STATE: Record<string, CheckState> = {
  success: "passed",
  failure: "failed",
  error: "failed",
  pending: "running",
};

interface RestPull {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  state: string;
  merged: boolean;
  user: { login: string } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } | null };
}

interface CheckRunsPayload {
  total_count: number;
  check_runs: { name: string; status: string; conclusion: string | null; html_url?: string }[];
}

interface StatusesPayload {
  statuses: { context: string; state: string; target_url?: string }[];
}

interface ThreadsPayload {
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: {
            id: string;
            author: { login: string } | null;
            state: string;
            body: string;
            submittedAt: string;
            commit: { oid: string } | null;
          }[];
        };
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string | null;
            line: number | null;
            diffSide: string | null;
            comments: {
              nodes: {
                author: { login: string } | null;
                body: string;
                url: string;
                originalCommit: { oid: string } | null;
              }[];
            };
          }[];
        };
      } | null;
    } | null;
  };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(last:50){nodes{id author{login} state body submittedAt commit{oid}}}
      reviewThreads(last:100){nodes{
        id isResolved isOutdated path line diffSide
        comments(first:50){nodes{author{login} body url originalCommit{oid}}}
      }}
    }
  }
}`;

function numberOf(ref: string): string {
  const m = /^(?:.*\/pull\/)?(\d+)\/?$/.exec(ref.trim());
  if (!m)
    throw new AxiError(`${ref} is not a pull request number or URL`, "VALIDATION_ERROR", [
      "Pass --change 123 or the full pull request URL",
    ]);
  return m[1]!;
}

export class GitHubForge implements Forge {
  readonly id = "github";
  readonly cli = "gh";

  private api(repo: RepoId, args: string[]): string[] {
    return ["api", "--hostname", repo.host, ...args];
  }

  async owns(host: string): Promise<boolean> {
    if (host === "github.com" || host === process.env["GH_HOST"]) return true;
    return ok("gh", ["auth", "status", "--hostname", host]);
  }

  async whoami(repo: RepoId): Promise<string> {
    const me = await runJson<{ login: string }>("gh", this.api(repo, ["user"]));
    return me.login;
  }

  repoFromRemote(url: string): RepoId | null {
    const m = parseRemote(url);
    return m && m.path.split("/").length === 2 ? m : null;
  }

  async get(repo: RepoId, ref: string): Promise<ChangeRequest> {
    const n = numberOf(ref);
    const pr = await runJson<RestPull>("gh", this.api(repo, [`repos/${repo.path}/pulls/${n}`]));
    return {
      number: String(pr.number),
      title: pr.title,
      url: pr.html_url,
      state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
      author: pr.user?.login ?? "unknown",
      head: pr.head.sha,
      headBranch: pr.head.ref,
      base: pr.base.sha,
      baseBranch: pr.base.ref,
      fromFork: (pr.head.repo?.full_name ?? repo.path) !== (pr.base.repo?.full_name ?? repo.path),
      draft: pr.draft,
      body: pr.body ?? "",
    };
  }

  fetchRef(cr: ChangeRequest): string {
    return `refs/pull/${cr.number}/head`;
  }

  async checks(repo: RepoId, cr: ChangeRequest): Promise<Check[]> {
    return this.checksForSha(repo, cr.head);
  }

  async baseline(repo: RepoId, branch: string): Promise<Check[]> {
    const tip = await runJson<{ sha: string }>(
      "gh",
      this.api(repo, [`repos/${repo.path}/commits/${encodeURIComponent(branch)}`]),
    );
    return this.checksForSha(repo, tip.sha);
  }

  private async checksForSha(repo: RepoId, sha: string): Promise<Check[]> {
    const runs = await runJson<CheckRunsPayload>(
      "gh",
      this.api(repo, [`repos/${repo.path}/commits/${sha}/check-runs?per_page=100`]),
    );
    const checks: Check[] = runs.check_runs.map((r) => ({
      name: r.name,
      state: r.status !== "completed" ? "running" : (CONCLUSION[r.conclusion ?? ""] ?? "unknown"),
      raw: r.status === "completed" ? (r.conclusion ?? "completed") : r.status,
      ...(r.html_url ? { url: r.html_url } : {}),
    }));
    const statuses = await runJson<StatusesPayload>(
      "gh",
      this.api(repo, [`repos/${repo.path}/commits/${sha}/status?per_page=100`]),
    );
    for (const s of statuses.statuses)
      checks.push({
        name: s.context,
        state: STATUS_STATE[s.state] ?? "unknown",
        raw: s.state,
        ...(s.target_url ? { url: s.target_url } : {}),
      });
    return checks;
  }

  async prior(
    repo: RepoId,
    cr: ChangeRequest,
  ): Promise<{ passes: PriorPass[]; threads: PriorThread[] }> {
    const [owner, name] = repo.path.split("/");
    const payload = await runJson<ThreadsPayload>(
      "gh",
      this.api(repo, [
        "graphql",
        "-f",
        `query=${THREADS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        // -F is the typed flag; only the Int! variable wants it. Everything
        // else, a comment body above all, goes through -f as a literal string
        // so a body starting with `@` is not read as a file path.
        "-F",
        `number=${cr.number}`,
      ]),
    );
    const pr = payload.data?.repository?.pullRequest;
    if (!pr)
      throw new AxiError(`pull request ${cr.number} not found on ${repo.path}`, "NOT_FOUND", [
        "Check the number and that the account can read the repository",
      ]);
    const passes: PriorPass[] = pr.reviews.nodes
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: r.id,
        author: r.author?.login ?? "unknown",
        verdict: verdictWord(r.state),
        at: r.submittedAt,
        ...(r.commit?.oid ? { commit: r.commit.oid } : {}),
        body: r.body,
      }));
    const threads: PriorThread[] = pr.reviewThreads.nodes.map((t) => {
      const first = t.comments.nodes[0];
      return {
        id: t.id,
        author: first?.author?.login ?? "unknown",
        ...(t.path ? { path: t.path } : {}),
        ...(t.line ? { line: t.line } : {}),
        side: t.diffSide === "LEFT" ? ("base" as const) : ("head" as const),
        resolved: t.isResolved,
        outdated: t.isOutdated,
        ...(first?.originalCommit?.oid ? { commit: first.originalCommit.oid } : {}),
        ...(first?.url ? { url: first.url } : {}),
        messages: t.comments.nodes.map((c) => ({
          author: c.author?.login ?? "unknown",
          body: c.body,
        })),
      };
    });
    return { passes, threads };
  }

  async submit(repo: RepoId, cr: ChangeRequest, s: Submission): Promise<SubmitResult> {
    const body = {
      commit_id: cr.head,
      body: s.body,
      event:
        s.verdict === "approve"
          ? "APPROVE"
          : s.verdict === "request-changes"
            ? "REQUEST_CHANGES"
            : "COMMENT",
      comments: s.comments.map(inline),
    };
    const out = await runJson<{ html_url?: string }>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/pulls/${cr.number}/reviews`,
        "--method",
        "POST",
        "--input",
        "-",
      ]),
      { input: JSON.stringify(body) },
    );
    return {
      verdict: s.verdict,
      posted: s.comments.length,
      ...(out.html_url ? { url: out.html_url } : {}),
      notes: [],
    };
  }

  async reply(
    repo: RepoId,
    _cr: ChangeRequest,
    threadId: string,
    body: string | undefined,
    resolve: boolean,
  ): Promise<{ replied: boolean; resolved: boolean; notes: string[] }> {
    if (body !== undefined)
      await run(
        "gh",
        this.api(repo, [
          "graphql",
          "-f",
          "query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){clientMutationId}}",
          "-f",
          `id=${threadId}`,
          "-f",
          `body=${body}`,
        ]),
      );
    if (resolve)
      await run(
        "gh",
        this.api(repo, [
          "graphql",
          "-f",
          "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
          "-f",
          `id=${threadId}`,
        ]),
      );
    return { replied: body !== undefined, resolved: resolve, notes: [] };
  }

  permalink(repo: RepoId, sha: string, path: string, from?: number, to?: number): string {
    const base = `https://${repo.host}/${repo.path}/blob/${sha}/${path}`;
    if (!from) return base;
    return to && to > from ? `${base}#L${from}-L${to}` : `${base}#L${from}`;
  }
}

function verdictWord(state: string): string {
  return state === "CHANGES_REQUESTED"
    ? "request-changes"
    : state === "APPROVED"
      ? "approve"
      : state.toLowerCase();
}

function inline(c: InlineComment): Record<string, unknown> {
  const side = c.side === "base" ? "LEFT" : "RIGHT";
  return {
    path: c.path,
    line: c.line,
    side,
    ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: side } : {}),
    body: c.body,
  };
}

/** `git@host:path.git`, `https://host/path.git`, `ssh://git@host/path`. */
export function parseRemote(url: string): RepoId | null {
  const text = url.trim();
  let m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(text);
  if (!m) m = /^(?:[^@]+@)([^:]+):(.+?)(?:\.git)?\/?$/.exec(text);
  if (!m) return null;
  return { host: m[1]!, path: m[2]! };
}
