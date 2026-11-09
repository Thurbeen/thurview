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

interface RestMr {
  iid: number;
  title: string;
  web_url: string;
  description: string | null;
  draft?: boolean;
  work_in_progress?: boolean;
  state: string;
  author: { username: string } | null;
  labels?: string[];
  sha: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
}

interface Discussion {
  id: string;
  notes: {
    id: number;
    body: string;
    system: boolean;
    resolvable: boolean;
    resolved?: boolean;
    author: { id?: number; username: string } | null;
    position?: {
      new_path?: string;
      old_path?: string;
      new_line?: number | null;
      old_line?: number | null;
      head_sha?: string;
    } | null;
  }[];
}

interface RestNote {
  id: number;
  body: string;
  system?: boolean;
  type?: string | null;
  position?: unknown;
  author: { username: string } | null;
}

function noteOf(n: RestNote): Note {
  return { id: String(n.id), author: n.author?.username ?? "unknown", body: n.body };
}

/** One JSON value per line; a line holding an array is a page of them. */
function ndjson<T>(out: string): T[] {
  return out
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => JSON.parse(l) as T | T[]);
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

  private bots = new Map<number, Promise<boolean>>();

  /**
   * A note's author carries no bot flag; the user record does. Read once per
   * account, and any doubt is `false`: a name alone never makes a bot.
   */
  private isBot(repo: RepoId, id: number): Promise<boolean> {
    if (!this.bots.has(id))
      this.bots.set(
        id,
        runJson<{ bot?: boolean }>("glab", this.api(repo, `users/${id}`)).then(
          (u) => u.bot === true,
          () => false,
        ),
      );
    return this.bots.get(id)!;
  }

  async canWrite(repo: RepoId, user: string): Promise<boolean> {
    try {
      const members = await runJson<{ username: string; access_level: number }[]>(
        "glab",
        this.api(
          repo,
          `projects/${this.project(repo)}/members/all?query=${encodeURIComponent(user)}`,
        ),
      );
      // 30 is Developer, the first level that can push.
      return members.some((m) => m.username === user && m.access_level >= 30);
    } catch {
      return false;
    }
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
      labels: mr.labels ?? [],
    };
  }

  async prior(
    repo: RepoId,
    cr: ChangeRequest,
  ): Promise<{ passes: PriorPass[]; threads: PriorThread[] }> {
    // Every page: each system event is a discussion of its own, so a busy
    // merge request passes one page long before its threads run out.
    const out = await run(
      "glab",
      this.api(
        repo,
        `projects/${this.project(repo)}/merge_requests/${cr.number}/discussions?per_page=100`,
        ["--paginate", "--output", "ndjson"],
      ),
    );
    const discussions = ndjson<Discussion>(out);
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
        bot: first.author?.id ? await this.isBot(repo, first.author.id) : false,
        ...(first.position?.new_path ? { path: first.position.new_path } : {}),
        ...(first.position?.new_line ? { line: first.position.new_line } : {}),
        side: first.position?.new_line ? ("head" as const) : ("base" as const),
        resolved:
          notes.some((n) => n.resolvable) && notes.every((n) => !n.resolvable || n.resolved),
        // GitLab reports no per-comment staleness; the head it was written
        // against is the only signal, and `prior` compares it in the CLI.
        outdated: false,
        ...(first.position?.head_sha ? { commit: first.position.head_sha } : {}),
        url: `${cr.url}#note_${first.id}`,
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

  /**
   * One diff discussion. The position is a nested object, and glab sends
   * `--raw-field` names literally: a bracketed name reaches a JSON body as the
   * key `position[position_type]`, which the API rejects. Post the document on
   * stdin instead, with the content type glab does not set for `--input`.
   */
  private async discussion(
    repo: RepoId,
    cr: ChangeRequest,
    refs: NonNullable<RestMr["diff_refs"]>,
    c: InlineComment,
  ): Promise<string | void> {
    const position = {
      position_type: "text",
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      new_path: c.path,
      old_path: c.path,
      ...(c.side === "base" ? { old_line: c.line } : { new_line: c.line }),
    };
    const posted = await runJson<{ notes?: { id: number }[] }>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/discussions`, [
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
      ]),
      { input: JSON.stringify({ body: c.body, position }) },
    );
    const note = posted.notes?.[0];
    return note ? `${cr.url}#note_${note.id}` : undefined;
  }

  /** A diff comment anchors at one line here; a range is anchored at its last. */
  async comment(repo: RepoId, cr: ChangeRequest, c: InlineComment): Promise<string | void> {
    const mr = await runJson<RestMr>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}`),
    );
    if (!mr.diff_refs)
      throw new AxiError("this merge request reports no diff refs", "FORGE_ERROR", [
        "Retry once the merge request has a diff",
      ]);
    return this.discussion(repo, cr, mr.diff_refs, c);
  }

  /**
   * Top-level notes only: a diff note belongs to a thread, and a system note
   * is GitLab narrating. Every page, as newline-delimited JSON, so a stop
   * command posted after the hundredth note still counts.
   */
  /** One version per push, each with the head it was pushed at. */
  async heads(repo: RepoId, cr: ChangeRequest): Promise<string[]> {
    const out = await run(
      "glab",
      this.api(
        repo,
        `projects/${this.project(repo)}/merge_requests/${cr.number}/versions?per_page=100`,
        ["--paginate", "--output", "ndjson"],
      ),
    );
    const versions = ndjson<{ head_commit_sha?: string }>(out).map((v) => v.head_commit_sha);
    return [...new Set([cr.head, ...versions])].filter((sha): sha is string => Boolean(sha));
  }

  async notes(repo: RepoId, cr: ChangeRequest): Promise<Note[]> {
    const out = await run(
      "glab",
      this.api(
        repo,
        `projects/${this.project(repo)}/merge_requests/${cr.number}/notes?per_page=100&sort=asc&order_by=created_at`,
        ["--paginate", "--output", "ndjson"],
      ),
    );
    return (
      out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RestNote)
        // A reply to a note turns it into a DiscussionNote, and it is still a
        // top-level note: only a note on a diff line is left out.
        .filter((n) => !n.system && n.type !== "DiffNote" && !n.position)
        .map(noteOf)
    );
  }

  async postNote(repo: RepoId, cr: ChangeRequest, body: string): Promise<Note> {
    const n = await runJson<RestNote>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/notes`, [
        "--method",
        "POST",
        "--raw-field",
        `body=${body}`,
      ]),
    );
    return noteOf(n);
  }

  async setStatus(repo: RepoId, _cr: ChangeRequest, sha: string, s: ReviewStatusCheck) {
    await runJson<unknown>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/statuses/${sha}`, [
        "--method",
        "POST",
        "--raw-field",
        `state=${s.state === "success" ? "success" : "failed"}`,
        "--raw-field",
        `name=${s.context}`,
        "--raw-field",
        `description=${s.description}`,
        ...(s.url ? ["--raw-field", `target_url=${s.url}`] : []),
      ]),
    );
  }

  /** An award emoji on the merge request; GitLab refuses a second one by the same account, so it is read first. */
  async eyes(repo: RepoId, cr: ChangeRequest): Promise<"added" | "present"> {
    const me = await this.whoami(repo);
    const base = `projects/${this.project(repo)}/merge_requests/${cr.number}/award_emoji`;
    const out = await run(
      "glab",
      this.api(repo, `${base}?per_page=100`, ["--paginate", "--output", "ndjson"]),
    );
    const awards = ndjson<{ name: string; user: { username: string } | null }>(out);
    if (awards.some((a) => a.name === "eyes" && a.user?.username === me)) return "present";
    await runJson<unknown>(
      "glab",
      this.api(repo, base, ["--method", "POST", "--raw-field", "name=eyes"]),
    );
    return "added";
  }

  async editNote(repo: RepoId, cr: ChangeRequest, id: string, body: string): Promise<void> {
    await runJson<unknown>(
      "glab",
      this.api(repo, `projects/${this.project(repo)}/merge_requests/${cr.number}/notes/${id}`, [
        "--method",
        "PUT",
        "--raw-field",
        `body=${body}`,
      ]),
    );
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
}
