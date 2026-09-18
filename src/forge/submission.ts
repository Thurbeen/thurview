import { z } from "zod";
import { AxiError } from "axi-sdk-js";
import type { Decision, Thread, ThreadMessage, ThreadTarget } from "../store.js";
import { targetLabel } from "../thread-state.js";
import type { InlineComment, Submission, Verdict } from "./types.js";

/**
 * The file `thurview forge submit` takes. One pass of a review: a summary, the
 * inline comments, and a verdict. It is a file rather than flags because a
 * review comment is prose with newlines in it, and because the file is the
 * thing a human can read before it is posted on their behalf.
 */
const Schema = z.object({
  verdict: z.enum(["comment", "approve", "request-changes"]),
  body: z.string().min(1),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        startLine: z.number().int().positive().optional(),
        side: z.enum(["head", "base"]).optional(),
        body: z.string().min(1),
      }),
    )
    .default([]),
});

export function parseSubmission(text: string, file: string): Submission {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AxiError(`${file} is not valid JSON: ${(e as Error).message}`, "VALIDATION_ERROR", [
      'The file holds {"verdict": "comment", "body": "...", "comments": []}',
    ]);
  }
  const parsed = Schema.safeParse(raw);
  if (!parsed.success)
    throw new AxiError(
      `${file} is not a submission: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
      "VALIDATION_ERROR",
      [
        "verdict is comment, approve or request-changes; body is the summary; comments[] each need path, line and body",
      ],
    );
  for (const c of parsed.data.comments)
    if (c.startLine && c.startLine > c.line)
      throw new AxiError(
        `${c.path}: startLine ${c.startLine} is after line ${c.line}`,
        "VALIDATION_ERROR",
        ["line is the LAST line of the range and startLine the first"],
      );
  return parsed.data;
}

/**
 * Comments long enough that the author will skim them. A finding that does
 * not fit is two findings, or a claim plus one suggestion with the evidence
 * behind a permalink - never a wall of prose on a line of someone's diff.
 */
export function longComments(s: Submission, max: number): string[] {
  return s.comments
    .map((c, i) => ({ c, i, lines: c.body.trimEnd().split("\n").length }))
    .filter((x) => x.lines > max)
    .map((x) => `comments[${x.i}] on ${x.c.path}:${x.c.line} is ${x.lines} lines (max ${max})`);
}

/**
 * What building a pass out of a review's threads decided. The counts are the
 * point: a reader who is not told where a comment went assumes it was posted
 * where they wrote it.
 */
export interface PassPlan {
  submission: Submission;
  decision: Decision["decision"];
  /** Why the verdict is not the decision the reader asked for; empty when it is. */
  verdictReason: string;
  inline: { thread: string; at: string; side: "head" | "base" }[];
  summary: { thread: string; target: string; why: string }[];
  skipped: { thread: string; target: string; why: string }[];
}

/**
 * The forge verdict a review decision carries. `close` has no counterpart:
 * the seam carries no close, deliberately, and ending a review here is not a
 * state change to make on somebody else's change request - so the findings go
 * as a `comment` and the change request's own state is left to its maintainer.
 */
function verdictOf(decision: Decision["decision"]): { verdict: Verdict; reason: string } {
  if (decision === "approve") return { verdict: "approve", reason: "" };
  if (decision === "request-changes") return { verdict: "request-changes", reason: "" };
  return {
    verdict: "comment",
    reason:
      "close ends the review without judging the change, and the seam has no close: the comments are posted and the change request's state is left alone",
  };
}

/** Why a thread never reaches the forge, in the words the reader needs to read. */
const SKIPPED = {
  question:
    "question: a conversation with the agent, and posting it shows the author an instruction never addressed to them",
  resolved:
    "resolved: it has done its job, and posting it again is how a thread arrives in the change request twice",
  held: "held: written after the review was submitted, so the reader never sent it",
} as const;

const UNANCHORED = "no line to anchor to, so the forge cannot hold it as an inline comment";

/** The line anchor a thread carries, or null when it has none to carry. */
function anchorOf(t: ThreadTarget): Omit<InlineComment, "body"> | null {
  // line 0 is the whole file: a target without a line, like a document block.
  if (t.type !== "file" || !t.line) return null;
  const end = t.endLine && t.endLine > t.line ? t.endLine : t.line;
  return { path: t.path, line: end, ...(end > t.line ? { startLine: t.line } : {}), side: t.side };
}

/**
 * What the reader has said that nobody has answered yet. An agent's reply in
 * the thread answers the reader, and the author of the change was never part
 * of that conversation - and a thread the reader reopened after an earlier
 * pass would otherwise carry its first message to the forge a second time,
 * which is the duplicate the resolved rule exists to prevent.
 */
function readerBody(th: Thread): string {
  const spoken = (ms: ThreadMessage[]) => ms.filter((m) => m.role === "reviewer" && m.body.trim());
  const answered = th.messages.findLastIndex((m) => m.role === "agent");
  const unanswered = spoken(th.messages.slice(answered + 1));
  const said = unanswered.length ? unanswered : spoken(th.messages);
  return said.map((m) => m.body.trim()).join("\n\n");
}

/** The summary note: what the reader said on submitting, then the comments no line could hold. */
function summaryBody(said: string | undefined, unanchored: string[], inline: number): string {
  const parts: string[] = [];
  if (said?.trim()) parts.push(said.trim());
  if (unanchored.length)
    parts.push(`### Comments with no line to anchor to\n\n${unanchored.join("\n\n")}`);
  if (!parts.length)
    parts.push(
      inline
        ? `${inline} inline comment${inline === 1 ? "" : "s"}, and the reader wrote no summary.`
        : "The reader wrote no summary, and left no comment to carry.",
    );
  return parts.join("\n\n");
}

/**
 * The submission a submitted review becomes: the threads the reader sent,
 * anchored where they have a line and gathered in the summary where they do
 * not, under the verdict their decision carries.
 *
 * An `approve` with threads still to post is refused rather than obeyed, and
 * never downgraded to a `comment`: a reader who asked to approve and got a
 * comment learns nothing, and an approve beside open findings clears a change
 * nobody cleared.
 */
export function buildPass(threads: Thread[], decision: Decision): PassPlan {
  const { verdict, reason } = verdictOf(decision.decision);
  const plan: Pick<PassPlan, "inline" | "summary" | "skipped"> = {
    inline: [],
    summary: [],
    skipped: [],
  };
  const comments: InlineComment[] = [];
  const unanchored: string[] = [];
  for (const th of threads) {
    const target = targetLabel(th.target);
    const why =
      th.kind === "question"
        ? SKIPPED.question
        : th.status === "resolved"
          ? SKIPPED.resolved
          : !th.submitted
            ? SKIPPED.held
            : "";
    if (why) {
      plan.skipped.push({ thread: th.id, target, why });
      continue;
    }
    const body = readerBody(th);
    const anchor = anchorOf(th.target);
    if (!anchor) {
      plan.summary.push({ thread: th.id, target, why: UNANCHORED });
      unanchored.push(`**${target}**\n\n${body}`);
      continue;
    }
    comments.push({ ...anchor, body });
    plan.inline.push({
      thread: th.id,
      at: `${anchor.path}:${anchor.startLine ? `${anchor.startLine}-${anchor.line}` : anchor.line}`,
      side: anchor.side ?? "head",
    });
  }
  const open = [...plan.inline, ...plan.summary];
  if (verdict === "approve" && open.length)
    throw new AxiError(
      `the decision is approve, but ${open.length} open thread${open.length === 1 ? "" : "s"} would be posted with it: ${open.map((x) => x.thread).join(", ")}`,
      "THREADS_OPEN",
      [
        "An approve beside findings clears a change nobody cleared, and posting it as a comment instead would tell the reader nothing",
        "Resolve each thread whose point is addressed - in the browser, or with `thurview threads resolve <threadId> --review <id>` - then run this again",
        "Do not resolve a thread you did not address: an approve is exactly the verdict that makes that invisible",
      ],
    );
  return {
    submission: {
      verdict,
      body: summaryBody(decision.body, unanchored, comments.length),
      comments,
    },
    decision: decision.decision,
    verdictReason: reason,
    ...plan,
  };
}
