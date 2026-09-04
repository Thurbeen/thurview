import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA = 1;

export type ReviewStatus =
  "draft" | "awaiting-review" | "awaiting-agent-updates" | "accepted" | "rejected";

export interface Binding {
  kind: "branch" | "pr" | "range";
  /** branch name, pr number, or "base..head" */
  name: string;
  url?: string;
}

export interface ReviewState {
  schema: number;
  id: string;
  title: string;
  worktree: string;
  repoRoot: string;
  binding: Binding;
  pins: { base: string; head: string };
  status: ReviewStatus;
  /** presented (sealed) revision number; 0 when nothing is published */
  revision: number;
  dismissed: boolean;
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
  decision: "approve" | "request-changes";
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

export async function readReview(id: string): Promise<ReviewState | null> {
  return readJson<ReviewState>(join(reviewDir(id), "review.json"));
}

export async function writeReview(state: ReviewState): Promise<void> {
  state.updatedAt = now();
  await writeJson(join(reviewDir(state.id), "review.json"), state);
}

export async function listReviews(): Promise<ReviewState[]> {
  if (!existsSync(reviewsDir())) return [];
  const ids = await readdir(reviewsDir());
  const out: ReviewState[] = [];
  for (const id of ids) {
    const r = await readReview(id);
    if (r) out.push(r);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export async function deleteReview(id: string): Promise<void> {
  await rm(reviewDir(id), { recursive: true, force: true });
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
