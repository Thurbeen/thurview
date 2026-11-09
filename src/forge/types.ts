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
 *   prior     every earlier review pass and every review thread, with who
 *             wrote it, whether it is resolved and which commit it was
 *             written against
 *   reply     answer one thread, and resolve it when its point is verified
 *   notes     the change request's top-level comments, to find the one
 *             summary a follow loop keeps and the stop command a reader posts
 *   postNote  post one top-level comment; editNote rewrites one in place
 *   comment   one inline comment, which opens one resolvable thread
 *   setStatus the review's verdict as a commit status on one sha, which a
 *             branch rule can require: it reports, and merges nothing
 *   eyes      the eyes reaction on the change request itself, by this
 *             account, once: what tells a reader a review is in progress
 *             before anything is posted
 *
 * WHAT IS NOT HERE, deliberately: merge, close, push. A review comments; the
 * maintainer merges. A seam with no merge method cannot be talked into one.
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
  labels: string[];
}

/** One commit status: `context` names it, as a branch rule requires it. */
export interface ReviewStatusCheck {
  context: string;
  state: "success" | "failure";
  /** One short line; GitHub cuts a status description at 140 characters. */
  description: string;
  url?: string;
}

/** A top-level comment on a change request, outside any review thread. */
export interface Note {
  /** Numeric on both forges, and increasing, so a later note has a larger id. */
  id: string;
  author: string;
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
  /** The forge says the author is a bot account, not a user who chose a bot-like name. */
  bot?: boolean;
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

export interface Forge {
  /** `github` or `gitlab`; what `--forge` takes. */
  readonly id: string;
  /** The CLI this adapter drives, so a missing one names itself. */
  readonly cli: string;
  /** Hosts this adapter owns, read off the machine rather than assumed. */
  owns(host: string): Promise<boolean>;
  /** The account the change request would be posted as. */
  whoami(repo: RepoId): Promise<string>;
  /** Whether `user` can push to the repository. Any doubt, an error included, is `false`. */
  canWrite(repo: RepoId, user: string): Promise<boolean>;
  /** A change request number or URL, resolved against `repo`. */
  get(repo: RepoId, ref: string): Promise<ChangeRequest>;
  prior(repo: RepoId, cr: ChangeRequest): Promise<{ passes: PriorPass[]; threads: PriorThread[] }>;
  reply(
    repo: RepoId,
    cr: ChangeRequest,
    threadId: string,
    body: string | undefined,
    resolve: boolean,
  ): Promise<{ replied: boolean; resolved: boolean; notes: string[] }>;
  notes(repo: RepoId, cr: ChangeRequest): Promise<Note[]>;
  postNote(repo: RepoId, cr: ChangeRequest, body: string): Promise<Note>;
  editNote(repo: RepoId, cr: ChangeRequest, id: string, body: string): Promise<void>;
  /**
   * Every commit this change request has had as its head, as far as the forge
   * records it: what a review after the end may name as the one it reviewed.
   */
  heads(repo: RepoId, cr: ChangeRequest): Promise<string[]>;
  /** The new thread URL, when the forge returns one. */
  comment(repo: RepoId, cr: ChangeRequest, c: InlineComment): Promise<string | void>;
  setStatus(repo: RepoId, cr: ChangeRequest, sha: string, s: ReviewStatusCheck): Promise<void>;
  /**
   * Add this account's eyes reaction to the change request, unless it is
   * already there. Other accounts' reactions are read past and never removed.
   */
  eyes(repo: RepoId, cr: ChangeRequest): Promise<"added" | "present">;
}
