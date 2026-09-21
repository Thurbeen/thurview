import * as g from "./git.js";
import {
  parseRemote,
  qualified,
  type ChangeRequest,
  type CiSummary,
  type RepoId,
} from "./forge/index.js";
import {
  forgeFactsFile,
  now,
  readJson,
  readThreads,
  writeJson,
  type Decision,
  type ReviewState,
  type ThreadsFile,
} from "./store.js";
import { needsAgent } from "./thread-state.js";

/**
 * The maintainer's queue: the home page's list of documents, given the columns
 * a maintainer triages on and ordered by whose turn it is. It is an index, not
 * a document - it reads every row as the store holds it now, so it is never
 * stale and never republished. The one thing it needs that the store does not
 * hold is what the forge said, and that arrives as `ForgeFacts`.
 */

/** What the forge last said about a document's change request, and when. */
export interface ForgeFacts {
  at: string;
  repo: string;
  number: string;
  url: string;
  state: ChangeRequest["state"];
  head: string;
  /** Only ever about `head`: a new head drops it rather than lend it a verdict it never had. */
  ci?: { trustworthy: boolean; verdict: string };
  /** The last pass posted from this document, so the queue knows a decision reached the forge. */
  posted?: { at: string; verdict: string; head: string };
}

/**
 * Record what a forge command just learned about the document's change
 * request. Only a document bound to that very change request records it, so a
 * `--change` aimed elsewhere never lends a row somebody else's facts.
 */
export async function recordForgeFacts(
  review: ReviewState | null,
  repo: RepoId,
  cr: ChangeRequest,
  add: Pick<ForgeFacts, "ci" | "posted"> = {},
): Promise<void> {
  if (!review || review.binding.kind !== "pr" || review.binding.name !== cr.number) return;
  const prev = await readJson<ForgeFacts>(forgeFactsFile(review.id));
  const facts: ForgeFacts = {
    at: now(),
    repo: qualified(repo),
    number: cr.number,
    url: cr.url,
    state: cr.state,
    head: cr.head,
    ...(prev?.ci && prev.head === cr.head ? { ci: prev.ci } : {}),
    ...(prev?.posted ? { posted: prev.posted } : {}),
    ...add,
  };
  await writeJson(forgeFactsFile(review.id), facts);
}

export function ciFacts(ci: CiSummary): ForgeFacts["ci"] {
  return { trustworthy: ci.trustworthy, verdict: ci.verdict };
}

export type Turn = "you" | "agent" | "nobody";

export interface QueueRow {
  /** `host/path` of the repository, or the checkout's path when it has no forge remote. */
  repo: string;
  /** null for a document not bound to a change request. */
  change: { number: string; url: string | null; state: ForgeFacts["state"] | null } | null;
  turn: Turn;
  /** Why it is that turn, in the words the row shows. */
  why: string;
  /** Position in the triage order; lower comes first. */
  rank: number;
  /** null when there is no change request, or the forge has not been asked yet. */
  pin: "at-head" | "behind" | null;
  decision: { decision: Decision["decision"]; posted: boolean | null } | null;
  ci: ForgeFacts["ci"] | null;
  /** When the forge facts were read; null when there are none. */
  factsAt: string | null;
}

/** The triage order, most urgent first. See `queueRow` for what puts a document in each. */
const RANK = { post: 0, read: 1, stale: 2, agent: 3, unread: 4, done: 5 } as const;

function turnOf(
  r: ReviewState,
  threads: ThreadsFile,
  facts: ForgeFacts | null,
  pin: QueueRow["pin"],
  decision: QueueRow["decision"],
): Pick<QueueRow, "turn" | "why" | "rank"> {
  const waiting = threads.threads.filter(needsAgent).length;
  if (r.dismissed) return { turn: "nobody", why: "dismissed", rank: RANK.done };
  if (facts && facts.state !== "open")
    return { turn: "nobody", why: `${facts.state} on the forge`, rank: RANK.done };
  if (decision?.posted === false)
    return { turn: "you", why: "decided, not yet posted to the change request", rank: RANK.post };
  if (r.status === "accepted" || r.status === "closed")
    return { turn: "nobody", why: r.status, rank: RANK.done };
  if (pin === "behind")
    return { turn: "agent", why: "the change request moved past the pin", rank: RANK.stale };
  if (waiting)
    return {
      turn: "agent",
      why: `${waiting} thread${waiting === 1 ? "" : "s"} waiting for the agent`,
      rank: RANK.agent,
    };
  if (r.status === "awaiting-review")
    return { turn: "you", why: "awaiting your reading", rank: RANK.read };
  if (r.status === "awaiting-agent-updates")
    return { turn: "agent", why: "revising after your decision", rank: RANK.agent };
  return { turn: "agent", why: "not published yet", rank: RANK.unread };
}

function queueRow(
  r: ReviewState,
  threads: ThreadsFile,
  facts: ForgeFacts | null,
  repo: string,
): QueueRow {
  const bound = r.binding.kind === "pr";
  const last = threads.decisions[threads.decisions.length - 1];
  const decision = last
    ? {
        decision: last.decision,
        posted: bound ? !!facts?.posted && facts.posted.at >= last.at : null,
      }
    : null;
  const pin = bound && facts ? (facts.head === r.pins.head ? "at-head" : "behind") : null;
  return {
    repo,
    change: bound
      ? {
          number: r.binding.name,
          url: facts?.url ?? r.binding.url ?? null,
          state: facts?.state ?? null,
        }
      : null,
    ...turnOf(r, threads, bound ? facts : null, pin, decision),
    pin,
    decision,
    ci: bound ? (facts?.ci ?? null) : null,
    factsAt: bound ? (facts?.at ?? null) : null,
  };
}

/** Longest-waiting first within a turn: the row that has sat there longest has cost the most. */
function byTurn(a: { queue: QueueRow; updatedAt: string }, b: typeof a): number {
  return a.queue.rank - b.queue.rank || (a.updatedAt < b.updatedAt ? -1 : 1);
}

/** The repository a checkout belongs to, by its `origin`; its path when it has none. */
async function originOf(repoRoot: string): Promise<string> {
  const url = (await g.git(repoRoot, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const repo = url ? parseRemote(url) : null;
  return repo ? qualified(repo) : repoRoot;
}

/**
 * Every document as a queue row, in triage order. Read from the store on
 * every call and never kept: an index that had to be rebuilt whenever any
 * document moved would be stale by construction.
 *
 * A checkout is named once, and by what the forge said when any of its
 * documents has asked it, so an explainer lands in the same group as the
 * change requests beside it rather than under a second name for the same
 * repository.
 */
export async function queue(reviews: ReviewState[]) {
  const loaded = await Promise.all(
    reviews.map(async (r) => ({
      r,
      threads: await readThreads(r.id),
      facts: await readJson<ForgeFacts>(forgeFactsFile(r.id)),
    })),
  );
  const names = new Map<string, string>();
  for (const { r, facts } of loaded)
    if (facts && !names.has(r.repoRoot)) names.set(r.repoRoot, facts.repo);
  for (const root of new Set(reviews.map((r) => r.repoRoot)))
    if (!names.has(root)) names.set(root, await originOf(root));
  return loaded
    .map(({ r, threads, facts }) => ({
      ...r,
      openThreads: threads.threads.filter((x) => x.status === "open").length,
      queue: queueRow(r, threads, facts, facts?.repo ?? names.get(r.repoRoot)!),
    }))
    .sort(byTurn);
}
