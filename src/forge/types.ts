/**
 * The FORGE seam - what a review needs to know about a proposed change, and
 * nothing about which forge answers it.
 *
 * THE WORD. GitHub calls it a pull request, GitLab a merge request. They are
 * the same thing to this code, which says CHANGE REQUEST throughout and never
 * picks a side. Prose that is genuinely about GitHub still says "pull
 * request", because there it is describing GitHub.
 *
 * THE QUESTIONS. Each method exists because a review step needs it, not
 * because a forge happens to offer it:
 *
 *   get       the change request itself - the head a review is written
 *             against, the branch it is open from, whether it comes from a
 *             fork
 *   checks    what CI did on that head, one row per job
 *   baseline  what CI does on the target branch's own tip, which is the only
 *             way to see that a fork change request ran almost nothing
 *   prior     every earlier review pass and every review thread, with who
 *             wrote it, whether it is resolved and which commit it was
 *             written against
 *   submit    one pass - a summary, inline comments, a verdict
 *   reply     answer one thread, and resolve it when its point is verified
 *   permalink a file and line range at a pinned commit, as a URL the author
 *             can open
 *
 * WHAT IS NOT HERE, deliberately: merge, close, push. A review comments; the
 * maintainer merges. A seam with no merge method cannot be talked into one.
 *
 * A CHECK THAT COULD NOT BE READ IS `unknown`, NEVER `passed`. Every mapping
 * below is explicit about which forge state becomes which verdict, because a
 * cancelled job that reads as a pass is how two real bugs shipped.
 */

/** One repository on one forge. The host is half of the name. */
export interface RepoId {
  host: string;
  /** `owner/repo` on GitHub, `group/subgroup/project` on GitLab. */
  path: string;
}

export function qualified(repo: RepoId): string {
  return `${repo.host}/${repo.path}`;
}

/**
 * What a CI job did. `skipped` and `cancelled` are separate from `failed` and
 * from each other on purpose - a cancelled job ran no assertion, and a green
 * summary that hides one is a lie about coverage.
 */
export type CheckState = "passed" | "failed" | "cancelled" | "skipped" | "running" | "unknown";

export interface Check {
  name: string;
  state: CheckState;
  /** The forge's own word for it, kept so an unmapped state is still visible. */
  raw: string;
  url?: string;
}

export interface ChangeRequest {
  /** `123` on GitHub, the iid on GitLab. */
  number: string;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  author: string;
  /** The commit a review is written against. */
  head: string;
  headBranch: string;
  /** Merge base of the target branch and the head, when the forge reports it. */
  base: string;
  baseBranch: string;
  /** True when the head lives in another repository, which is what strips CI. */
  fromFork: boolean;
  draft: boolean;
  body: string;
}

export interface PriorPass {
  id: string;
  author: string;
  /** The forge's verdict word, normalised where the two forges agree. */
  verdict: string;
  at: string;
  /** The head the pass was written against, when the forge records it. */
  commit?: string;
  body: string;
}

export interface PriorThread {
  /** The id `reply` takes. Opaque, and forge-specific by design. */
  id: string;
  author: string;
  path?: string;
  line?: number;
  side?: "head" | "base";
  resolved: boolean;
  /** The code under it moved since the comment was written. */
  outdated: boolean;
  commit?: string;
  url?: string;
  /** Every message in the thread, oldest first. */
  messages: { author: string; body: string }[];
}

export interface InlineComment {
  path: string;
  /** Last line of the range, which is where both forges anchor a comment. */
  line: number;
  startLine?: number;
  side?: "head" | "base";
  body: string;
}

/** `comment` posts findings without a verdict; the other two are state changes. */
export type Verdict = "comment" | "approve" | "request-changes";

export interface Submission {
  verdict: Verdict;
  body: string;
  comments: InlineComment[];
}

export interface SubmitResult {
  verdict: Verdict;
  /** Comments the forge accepted. */
  posted: number;
  url?: string;
  /** Anything the forge did differently from what was asked. */
  notes: string[];
}

export interface Forge {
  /** `github` or `gitlab`; what `--forge` takes. */
  readonly id: string;
  /** The CLI this adapter drives, so a missing one names itself. */
  readonly cli: string;
  /** Hosts this adapter owns, read off the machine rather than assumed. */
  owns(host: string): Promise<boolean>;
  /** The account the change request would be posted as. */
  whoami(repo: RepoId): Promise<string>;
  repoFromRemote(url: string): RepoId | null;
  /** A change request number or URL, resolved against `repo`. */
  get(repo: RepoId, ref: string): Promise<ChangeRequest>;
  /** The ref the forge publishes the head under, so a fork's head can be fetched. */
  fetchRef(cr: ChangeRequest): string;
  checks(repo: RepoId, cr: ChangeRequest): Promise<Check[]>;
  baseline(repo: RepoId, branch: string): Promise<Check[]>;
  prior(repo: RepoId, cr: ChangeRequest): Promise<{ passes: PriorPass[]; threads: PriorThread[] }>;
  submit(repo: RepoId, cr: ChangeRequest, s: Submission): Promise<SubmitResult>;
  reply(
    repo: RepoId,
    cr: ChangeRequest,
    threadId: string,
    body: string | undefined,
    resolve: boolean,
  ): Promise<{ replied: boolean; resolved: boolean; notes: string[] }>;
  permalink(repo: RepoId, sha: string, path: string, from?: number, to?: number): string;
}
