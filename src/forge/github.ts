import { AxiError } from "axi-sdk-js";
import { run, runJson, ok } from "./run.js";
import type {
  ChangeRequest,
  Forge,
  InlineComment,
  Note,
  ReviewStatusCheck,
  PriorPass,
  PriorThread,
  RepoId,
} from "./types.js";

const HEADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 250) { nodes { commit { oid } } }
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], last: 100) {
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } }
      }
    }
  }
}`;

interface HeadsPayload {
  data?: {
    repository?: {
      pullRequest?: {
        commits: { nodes: { commit: { oid: string } }[] };
        timelineItems: {
          nodes: { beforeCommit?: { oid: string } | null; afterCommit?: { oid: string } | null }[];
        };
      } | null;
    } | null;
  };
}

/**
 * GitHub, through `gh`. Everything goes through `gh api` rather than the
 * porcelain: `gh pr view` answers a different question per version, and the
 * REST and GraphQL payloads are the contract this adapter is written against.
 */

interface RestPull {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  state: string;
  merged: boolean;
  user: { login: string } | null;
  labels?: { name: string }[];
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } | null };
}

interface ThreadsPayload {
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: {
            id: string;
            author: Author | null;
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
                author: Author | null;
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

/** A GraphQL actor. A bot's login there drops the `[bot]` its REST login carries. */
type Author = { __typename?: string; login: string };

/**
 * The REST login, which is what every other call compares against. Only a
 * Bot-typed actor gets `[bot]` back: a user may register the bare name.
 */
function loginOf(a: Author | null | undefined): string {
  if (!a) return "unknown";
  return a.__typename === "Bot" ? `${a.login}[bot]` : a.login;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(last:50){nodes{id author{__typename login} state body submittedAt commit{oid}}}
      reviewThreads(last:100){nodes{
        id isResolved isOutdated path line diffSide
        comments(first:50){nodes{author{__typename login} body url originalCommit{oid}}}
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

  async canWrite(repo: RepoId, user: string): Promise<boolean> {
    try {
      const p = await runJson<{ permission?: string }>(
        "gh",
        this.api(repo, [`repos/${repo.path}/collaborators/${encodeURIComponent(user)}/permission`]),
      );
      return p.permission === "admin" || p.permission === "write";
    } catch {
      return false;
    }
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
      labels: (pr.labels ?? []).map((l) => l.name),
    };
  }

  /**
   * The PR's commits, each of which was its head once it was pushed, and both
   * sides of every force-push, which is what keeps a head a rebase dropped.
   */
  async heads(repo: RepoId, cr: ChangeRequest): Promise<string[]> {
    const [owner, name] = repo.path.split("/");
    const payload = await runJson<HeadsPayload>(
      "gh",
      this.api(repo, [
        "graphql",
        "-f",
        `query=${HEADS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${cr.number}`,
      ]),
    );
    const pr = payload.data?.repository?.pullRequest;
    if (!pr)
      throw new AxiError(`pull request ${cr.number} not found on ${repo.path}`, "NOT_FOUND", [
        "Check the number and that the account can read the repository",
      ]);
    const pushed = pr.timelineItems.nodes.flatMap((e) => [e.beforeCommit?.oid, e.afterCommit?.oid]);
    const commits = pr.commits.nodes.map((n) => n.commit.oid);
    return [...new Set([cr.head, ...commits.reverse(), ...pushed])].filter((sha): sha is string =>
      Boolean(sha),
    );
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
        author: loginOf(r.author),
        verdict: verdictWord(r.state),
        at: r.submittedAt,
        ...(r.commit?.oid ? { commit: r.commit.oid } : {}),
        body: r.body,
      }));
    const threads: PriorThread[] = pr.reviewThreads.nodes.map((t) => {
      const first = t.comments.nodes[0];
      return {
        id: t.id,
        author: loginOf(first?.author),
        bot: first?.author?.__typename === "Bot",
        ...(t.path ? { path: t.path } : {}),
        ...(t.line ? { line: t.line } : {}),
        side: t.diffSide === "LEFT" ? ("base" as const) : ("head" as const),
        resolved: t.isResolved,
        outdated: t.isOutdated,
        ...(first?.originalCommit?.oid ? { commit: first.originalCommit.oid } : {}),
        ...(first?.url ? { url: first.url } : {}),
        messages: t.comments.nodes.map((c) => ({
          author: loginOf(c.author),
          body: c.body,
        })),
      };
    });
    return { passes, threads };
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

  /** Every page: a stop command posted after the hundredth comment still counts. */
  async notes(repo: RepoId, cr: ChangeRequest): Promise<Note[]> {
    const pages = await runJson<IssueComment[][]>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/issues/${cr.number}/comments?per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    );
    return pages.flat().map(noteOf);
  }

  async postNote(repo: RepoId, cr: ChangeRequest, body: string): Promise<Note> {
    const c = await runJson<IssueComment>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/issues/${cr.number}/comments`,
        "--method",
        "POST",
        "--input",
        "-",
      ]),
      { input: JSON.stringify({ body }) },
    );
    return noteOf(c);
  }

  async editNote(repo: RepoId, _cr: ChangeRequest, id: string, body: string): Promise<void> {
    await run(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/issues/comments/${id}`,
        "--method",
        "PATCH",
        "--input",
        "-",
      ]),
      { input: JSON.stringify({ body }) },
    );
  }

  async setStatus(repo: RepoId, _cr: ChangeRequest, sha: string, s: ReviewStatusCheck) {
    // A commit status, not a check run: GitHub lets only an App create check
    // runs, and `gh` is logged in as a user. A ruleset requires either alike.
    await run(
      "gh",
      this.api(repo, [`repos/${repo.path}/statuses/${sha}`, "--method", "POST", "--input", "-"]),
      {
        input: JSON.stringify({
          state: s.state,
          context: s.context,
          description: s.description.slice(0, 140),
          ...(s.url ? { target_url: s.url } : {}),
        }),
      },
    );
  }

  /** A pull request is an issue to the reactions API, so this is the issue reactions endpoint. */
  async eyes(repo: RepoId, cr: ChangeRequest): Promise<"added" | "present"> {
    const me = await this.whoami(repo);
    const pages = await runJson<{ content: string; user: { login: string } | null }[][]>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/issues/${cr.number}/reactions?content=eyes&per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    );
    if (pages.flat().some((r) => r.content === "eyes" && r.user?.login === me)) return "present";
    await runJson<unknown>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/issues/${cr.number}/reactions`,
        "--method",
        "POST",
        "--input",
        "-",
      ]),
      { input: JSON.stringify({ content: "eyes" }) },
    );
    return "added";
  }

  async comment(repo: RepoId, cr: ChangeRequest, c: InlineComment): Promise<string | void> {
    const posted = await runJson<{ html_url?: string }>(
      "gh",
      this.api(repo, [
        `repos/${repo.path}/pulls/${cr.number}/comments`,
        "--method",
        "POST",
        "--input",
        "-",
      ]),
      { input: JSON.stringify({ commit_id: cr.head, ...inline(c) }) },
    );
    return posted.html_url;
  }
}

interface IssueComment {
  id: number;
  user: { login: string } | null;
  body: string | null;
}

function noteOf(c: IssueComment): Note {
  return { id: String(c.id), author: c.user?.login ?? "unknown", body: c.body ?? "" };
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
