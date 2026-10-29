import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA = 1;

export type ReviewStatus =
  "draft" | "awaiting-review" | "awaiting-agent-updates" | "accepted" | "closed";

/**
 * The document kinds thurview dropped. A record an older thurview wrote for one
 * keeps its `kind`, so it is refused by name instead of being read as a review
 * it is not; it can still be deleted.
 */
export const REMOVED_KINDS = ["explainer", "design"] as const;
export type RemovedKind = (typeof REMOVED_KINDS)[number];

export interface Binding {
  /** `codebase` only on a record of a removed kind */
  kind: "branch" | "pr" | "range" | "codebase";
  /** branch name, change request number, or "base..head" */
  name: string;
  url?: string;
  /** `github` or `gitlab` for a change request; absent on reviews pinned before forges were named. */
  forge?: string;
}

export interface ReviewState {
  schema: number;
  id: string;
  /** absent on a review; set only on a record of a removed kind */
  kind?: string;
  title: string;
  worktree: string;
  repoRoot: string;
  binding: Binding;
  pins: { base: string; head: string };
  status: ReviewStatus;
  /** presented (sealed) revision number; 0 when nothing is published */
  revision: number;
  dismissed: boolean;
  staticSnapshot?: { url: string; revision: number; target?: string };
  createdAt: string;
  updatedAt: string;
}

export type ThreadTarget =
  | { type: "document"; blockId: string; quote?: string }
  /** line 0 means the whole file; endLine (>= line) makes a range */
  | {
      type: "file";
      path: string;
      side: "base" | "head";
      line: number;
      endLine?: number;
      quote?: string;
    }
  | { type: "map"; node: string }
  | { type: "review" };

export interface ThreadMessage {
  role: "reviewer" | "agent";
  body: string;
  at: string;
}

export interface Thread {
  id: string;
  kind: "question" | "comment";
  /** ask: delivered to the agent at once. review: held until the reviewer submits. */
  mode: "ask" | "review";
  /**
   * `open` means someone still owes something here. A message from the reviewer
   * forces it back to `open`, because `needsAgent` - the queue `wait` and
   * `threads list --open` read - is false for a resolved thread, and a reply
   * nobody is assigned to reaches nobody. See references/lifecycle.md.
   */
  status: "open" | "resolved";
  submitted: boolean;
  target: ThreadTarget;
  revision: number;
  messages: ThreadMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  at: string;
  decision: "approve" | "request-changes" | "close";
  revision: number;
  body?: string;
}

export interface ThreadsFile {
  threads: Thread[];
  decisions: Decision[];
}

export function home(): string {
  return process.env["THURVIEW_HOME"] || join(homedir(), ".thurview");
}

export function reviewsDir(): string {
  return join(home(), "reviews");
}

export function reviewDir(id: string): string {
  return join(reviewsDir(), id);
}

export function revisionDir(id: string, n: number): string {
  return join(reviewDir(id), "revisions", String(n));
}

export function serverStateFile(): string {
  return join(home(), "server.json");
}

/**
 * The submission `forge pass` wrote for this review, waiting for a human to
 * read it and `forge submit` to post it. Outside `reviewDir` for the same
 * reason as `agentFile`: the server watches that directory, and a write in it
 * reloads the reader's page.
 */
export function passFile(id: string): string {
  return join(home(), "passes", `${id}.json`);
}

/**
 * What the forge last said about the change request a document is bound to,
 * written by the commands that already ask it. Outside `reviewDir` for the
 * same reason as `passFile`, and never part of a sealed revision: it ages on
 * its own clock, and the queue shows that age rather than hiding it.
 */
export function forgeFactsFile(id: string): string {
  return join(home(), "forge", `${id}.json`);
}

/**
 * Heartbeat of an agent draining this review's threads. It lives outside
 * `reviewDir` on purpose: the server watches that directory to push changes to
 * the browser, and a file rewritten every few seconds would reload the page
 * under the reader's hands.
 */
export function agentFile(id: string): string {
  return join(home(), "agents", `${id}.json`);
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

/** The removed kind a stored record was written for, or null for a review. */
export function removedKind(r: Pick<ReviewState, "kind">): RemovedKind | null {
  return REMOVED_KINDS.find((k) => k === r.kind) ?? null;
}

export async function readReview(id: string): Promise<ReviewState | null> {
  const review = await readJson<ReviewState>(join(reviewDir(id), "review.json"));
  if (!review) return null;
  const snapshot = await readJson<ReviewState["staticSnapshot"]>(
    join(reviewDir(id), "static.json"),
  );
  if (snapshot) review.staticSnapshot = snapshot;
  return review;
}

export async function writeReview(state: ReviewState): Promise<void> {
  state.updatedAt = now();
  await writeJson(join(reviewDir(state.id), "review.json"), state);
}

/** Every review, newest first; `removed` keeps the records of removed kinds too. */
export async function listReviews(opts: { removed?: boolean } = {}): Promise<ReviewState[]> {
  if (!existsSync(reviewsDir())) return [];
  const ids = await readdir(reviewsDir());
  const out: ReviewState[] = [];
  for (const id of ids) {
    const r = await readReview(id);
    if (r && (opts.removed || !removedKind(r))) out.push(r);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export async function deleteReview(id: string): Promise<void> {
  await rm(reviewDir(id), { recursive: true, force: true });
  await rm(agentFile(id), { force: true });
  // The pass carries the reader's own words, so it goes with the review.
  await rm(passFile(id), { force: true });
  await rm(forgeFactsFile(id), { force: true });
}

export async function readThreads(id: string): Promise<ThreadsFile> {
  return (
    (await readJson<ThreadsFile>(join(reviewDir(id), "threads.json"))) ?? {
      threads: [],
      decisions: [],
    }
  );
}

export async function writeThreads(id: string, t: ThreadsFile): Promise<void> {
  await writeJson(join(reviewDir(id), "threads.json"), t);
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  await writeAtomic(path, text);
}

export async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Reviews bound to a worktree, newest first. */
export async function reviewsFor(worktree: string): Promise<ReviewState[]> {
  return (await listReviews()).filter((r) => r.worktree === worktree);
}
