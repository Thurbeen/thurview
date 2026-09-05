import {
  readThreads,
  writeThreads,
  readReview,
  writeReview,
  newId,
  now,
  type Thread,
  type ThreadTarget,
  type ThreadsFile,
} from "./store.js";

export async function createThread(
  reviewId: string,
  input: {
    kind: "question" | "comment";
    mode: "ask" | "review";
    target: ThreadTarget;
    body: string;
  },
): Promise<Thread> {
  const review = await readReview(reviewId);
  if (!review) throw new Error("review not found");
  const t = await readThreads(reviewId);
  const at = now();
  const thread: Thread = {
    id: newId().slice(0, 8),
    kind: input.kind,
    mode: input.mode,
    status: "open",
    submitted: input.mode === "ask",
    target: input.target,
    revision: review.revision,
    messages: [{ role: "reviewer", body: input.body, at }],
    createdAt: at,
    updatedAt: at,
  };
  t.threads.push(thread);
  await writeThreads(reviewId, t);
  return thread;
}

export async function replyThread(
  reviewId: string,
  threadId: string,
  role: "reviewer" | "agent",
  body: string,
): Promise<Thread> {
  const t = await readThreads(reviewId);
  const thread = t.threads.find((x) => x.id === threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);
  thread.messages.push({ role, body, at: now() });
  thread.updatedAt = now();
  if (role === "reviewer" && thread.mode === "ask") thread.submitted = true;
  await writeThreads(reviewId, t);
  return thread;
}

export async function setThreadStatus(
  reviewId: string,
  threadId: string,
  status: "open" | "resolved",
): Promise<Thread> {
  const t = await readThreads(reviewId);
  const thread = t.threads.find((x) => x.id === threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);
  thread.status = status;
  thread.updatedAt = now();
  await writeThreads(reviewId, t);
  return thread;
}

export async function deleteThread(reviewId: string, threadId: string): Promise<void> {
  const t = await readThreads(reviewId);
  t.threads = t.threads.filter((x) => x.id !== threadId);
  await writeThreads(reviewId, t);
}

/**
 * Submit the review: pending comments become visible to the agent and the status moves.
 * `close` ends the review without approving it.
 */
export async function submitReview(
  reviewId: string,
  decision: "approve" | "request-changes" | "close",
  body?: string,
): Promise<ThreadsFile> {
  const review = await readReview(reviewId);
  if (!review) throw new Error("review not found");
  if (review.status === "accepted" || review.status === "closed")
    throw new Error(`review is ${review.status}`);
  const t = await readThreads(reviewId);
  for (const th of t.threads) if (!th.submitted) th.submitted = true;
  t.decisions.push({ at: now(), decision, revision: review.revision, ...(body ? { body } : {}) });
  await writeThreads(reviewId, t);
  review.status =
    decision === "approve"
      ? "accepted"
      : decision === "close"
        ? "closed"
        : "awaiting-agent-updates";
  await writeReview(review);
  return t;
}

/** Threads the agent must act on: open, submitted, and the last message is from the reviewer. */
export function needsAgent(th: Thread): boolean {
  if (th.status !== "open" || !th.submitted) return false;
  const last = th.messages[th.messages.length - 1];
  return !!last && last.role === "reviewer";
}

export function threadSummary(th: Thread) {
  return {
    id: th.id,
    kind: th.kind,
    mode: th.mode,
    status: th.status,
    submitted: th.submitted,
    target: th.target,
    revision: th.revision,
    messages: th.messages,
  };
}
