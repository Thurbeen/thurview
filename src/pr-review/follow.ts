import { AxiError } from "axi-sdk-js";
import type { ChangeRequest, Forge, Note, RepoId } from "../forge/types.js";
import type { Category, Severity } from "./categories.js";
import {
  bareSummary,
  checkPass,
  findingId,
  readFindingMarker,
  readSummaryMarker,
  renderFinding,
  renderSummary,
  restate,
  statusLine,
  type Finding,
  type OpenFinding,
  type Pass,
  type ReviewStatus,
  type SummaryMarker,
} from "./format.js";

/**
 * Following a change request until it is merged or closed: one summary,
 * edited in place; one thread per finding, resolved when it is fixed; nothing
 * kept on this machine. Every call reads the state back from the forge, which
 * is what lets the loop die and resume anywhere.
 *
 * NEVER approve, merge or push. The seam has no merge and no push, and this
 * module calls neither `submit` nor anything else that changes the change
 * request's own state: the verdict is the summary's confidence.
 */

/** The forge methods a follow loop uses, and no other. */
export type ReviewForge = Pick<
  Forge,
  "id" | "whoami" | "get" | "prior" | "reply" | "notes" | "postNote" | "editNote" | "comment"
>;

export interface Ctx {
  forge: ReviewForge;
  repo: RepoId;
  cr: ChangeRequest;
}

export const STOP_LABEL = "thurview:stop";
const STOP_COMMAND = /^\s*\/thurview\s+stop\b/i;

export interface FindingState {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  path?: string;
  line?: number;
  open: boolean;
  thread: string;
  url?: string;
}

export interface ReviewState {
  summary: { note: Note; marker: SummaryMarker } | null;
  findings: FindingState[];
  /** Why the reader asked to stop, when they did and the summary does not say so yet. */
  stop: string | null;
  /** The newest note id on the change request. */
  newest: string;
}

function maxId(...ids: string[]): string {
  return ids.reduce((a, b) => (Number(b) > Number(a) ? b : a), "0");
}

export async function readState(ctx: Ctx): Promise<ReviewState> {
  const [notes, prior, me] = await Promise.all([
    ctx.forge.notes(ctx.repo, ctx.cr),
    ctx.forge.prior(ctx.repo, ctx.cr),
    ctx.forge.whoami(ctx.repo),
  ]);
  // Only this account's own marker counts: anyone can paste one, and
  // trusting it would let a commenter silence the loop or have it edit
  // their comment.
  let summary: ReviewState["summary"] = null;
  for (const note of notes) {
    const marker = note.author === me ? readSummaryMarker(note.body) : null;
    if (marker) {
      // A change request reopened after it closed is followed again.
      const ended = marker.state === "merged" || marker.state === "closed";
      summary = {
        note,
        marker: ended && ctx.cr.state === "open" ? { ...marker, state: "active" } : marker,
      };
      break;
    }
  }
  const findings: FindingState[] = [];
  for (const t of prior.threads) {
    const m = t.author === me ? readFindingMarker(t.messages[0]?.body ?? "") : null;
    if (!m) continue;
    findings.push({
      id: m.id,
      category: m.category,
      severity: m.severity,
      title: m.title,
      ...(t.path ? { path: t.path } : {}),
      ...(t.line ? { line: t.line } : {}),
      open: !t.resolved,
      thread: t.id,
      ...(t.url ? { url: t.url } : {}),
    });
  }
  const seen = summary?.marker.seen ?? "0";
  const command = notes.find(
    (n) => n !== summary?.note && STOP_COMMAND.test(n.body) && Number(n.id) > Number(seen),
  );
  const stop = ctx.cr.labels.includes(STOP_LABEL)
    ? `the ${STOP_LABEL} label`
    : command
      ? `a /thurview stop comment by @${command.author}`
      : null;
  return { summary, findings, stop, newest: maxId(...notes.map((n) => n.id)) };
}

export interface SyncResult {
  summary: "created" | "edited" | "dry-run";
  head: string;
  posted: { id: string; at: string }[];
  resolved: string[];
  duplicates: string[];
  open: number;
  blocking: number;
  body: string;
  sinceLastReview: { resolved: number; new: number; stillOpen: number };
}

/**
 * One pass on the current head. Everything is checked before anything is
 * posted; then the new findings, then the fixed threads, then the summary
 * last, so a pass that fails part-way leaves a summary that still describes
 * the head before it, and running it again posts only what is missing.
 */
export async function sync(
  ctx: Ctx,
  pass: Pass,
  opts: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const { forge, repo, cr } = ctx;
  if (cr.state !== "open")
    throw new AxiError(`the change request is ${cr.state}`, "CONFLICT", [
      "There is nothing left to review; the follow loop ends here",
    ]);
  checkPass(pass);
  if (!cr.head.startsWith(pass.head))
    throw new AxiError(
      `the pass reviewed ${pass.head.slice(0, 12)}, and the head is now ${cr.head.slice(0, 12)}`,
      "CONFLICT",
      [
        `Review \`git diff ${pass.head.slice(0, 12)} ${cr.head.slice(0, 12)}\` as well, then sync with head ${cr.head}`,
        "Its line numbers are the old head's, so posting it would land comments on the wrong lines",
      ],
    );
  const st = await readState(ctx);
  const status = st.summary?.marker.state;
  if (st.stop || (status && status !== "active"))
    throw new AxiError(
      `the review of this change request is stopped (${st.stop ?? `the summary says ${status}`})`,
      "CONFLICT",
      [`Run \`thurview pr-review start --change ${cr.number}\` if the reader asked to resume`],
    );
  // A finding resolved already - by an earlier run of this same pass, or by
  // hand - is done; only an id never posted is a mistake.
  const fixed = (pass.fixed ?? []).filter((id) => st.findings.some((x) => x.id === id && x.open));
  for (const id of pass.fixed ?? []) {
    if (!st.findings.some((x) => x.id === id))
      throw new AxiError(`no open finding ${id} on this change request`, "NOT_FOUND", [
        `The open ones: ${
          st.findings
            .filter((x) => x.open)
            .map((x) => x.id)
            .join(", ") || "none"
        }`,
        "Run `thurview pr-review status` for their ids",
      ]);
  }
  const fresh: { id: string; f: Finding }[] = [];
  const duplicates: string[] = [];
  for (const f of pass.findings ?? []) {
    const id = findingId(f);
    if (st.findings.some((x) => x.id === id && x.open) || fresh.some((x) => x.id === id))
      duplicates.push(id);
    else fresh.push({ id, f });
  }
  const open: OpenFinding[] = [
    ...st.findings.filter((x) => x.open && !fixed.includes(x.id)),
    ...fresh.map(({ id, f }) => ({ ...f, id })),
  ];
  const blocking = open.filter((x) => x.severity === "blocking").length;
  if (blocking && pass.confidence >= 3)
    throw new AxiError(
      `confidence ${pass.confidence} beside ${blocking} open blocking finding${blocking === 1 ? "" : "s"}`,
      "VALIDATION_ERROR",
      [
        "A blocking finding means the change is not safe to merge: confidence is 1 or 2",
        "Or the finding is not blocking: say so with its severity",
      ],
    );
  const marker: SummaryMarker = {
    head: cr.head,
    state: "active",
    seen: maxId(st.newest, st.summary?.marker.seen ?? "0"),
  };
  const sinceLastReview = {
    resolved: fixed.length,
    new: fresh.length,
    stillOpen: st.findings.filter((x) => x.open && !fixed.includes(x.id)).length,
  };
  const update = {
    first: !st.summary,
    counts: sinceLastReview,
    reviewedAt: new Date().toISOString(),
  };
  const body = renderSummary(pass, marker, cr.author, open, update);
  const result: SyncResult = {
    summary: opts.dryRun ? "dry-run" : st.summary ? "edited" : "created",
    head: cr.head,
    posted: fresh.map(({ id, f }) => ({ id, at: `${f.path}:${f.line}` })),
    resolved: fixed,
    duplicates,
    open: open.length,
    blocking,
    body,
    sinceLastReview,
  };
  if (opts.dryRun) return result;

  for (const { id, f } of fresh) {
    const url = await forge.comment(repo, cr, {
      path: f.path,
      line: f.line,
      ...(f.startLine && f.startLine < f.line ? { startLine: f.startLine } : {}),
      ...(f.side ? { side: f.side } : {}),
      body: renderFinding(f, pass.signoff, forge.id),
    });
    if (url) open.find((x) => x.id === id)!.url = url;
  }
  const reply = `Fixed in ${cr.head.slice(0, 7)}.${pass.signoff ? `\n\n${pass.signoff}` : ""}`;
  for (const id of fixed)
    await forge.reply(
      repo,
      cr,
      st.findings.find((x) => x.id === id && x.open)!.thread,
      reply,
      true,
    );
  result.body = renderSummary(pass, marker, cr.author, open, update);
  if (st.summary) await forge.editNote(repo, cr, st.summary.note.id, result.body);
  else await forge.postNote(repo, cr, result.body);
  return result;
}

/** Rewrite the summary's state and opening line, or post a bare one when there is none. */
async function mark(ctx: Ctx, st: ReviewState, state: ReviewStatus, opening?: string) {
  const m: SummaryMarker = {
    head: st.summary?.marker.head ?? ctx.cr.head,
    state,
    seen: maxId(st.newest, st.summary?.marker.seen ?? "0"),
  };
  const line = opening ?? statusLine(m)!;
  if (st.summary)
    await ctx.forge.editNote(
      ctx.repo,
      ctx.cr,
      st.summary.note.id,
      restate(st.summary.note.body, m, line),
    );
  else await ctx.forge.postNote(ctx.repo, ctx.cr, bareSummary(m, line));
}

/** Stop following: the summary says so, and every later wait answers `stopped`. */
export async function stopReview(ctx: Ctx): Promise<void> {
  await mark(ctx, await readState(ctx), "stopped");
}

/** Resume after a stop. Stop commands posted before now are spent. */
export async function startReview(ctx: Ctx): Promise<void> {
  if (ctx.cr.labels.includes(STOP_LABEL))
    throw new AxiError(`the change request still carries ${STOP_LABEL}`, "CONFLICT", [
      "Remove the label first; it is the reader's stop, and only they lift it",
    ]);
  const st = await readState(ctx);
  if (!st.summary) return;
  await mark(ctx, st, "active", "Next: me — review resumed; the next push gets a pass.");
}

export type WaitEvent =
  | { event: "push"; since: string | null; head: string }
  | { event: "merged" | "closed" | "stopped"; head: string; why?: string }
  | { event: "none"; head: string };

export interface WaitOptions {
  /** Seconds between polls. */
  interval: number;
  /** Seconds before giving up with `none`, so one call fits an agent's tool limit. */
  timeout: number;
  sleep?: (seconds: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
const realNow = () => Date.now() / 1000;

/**
 * Block until there is something to do: a head the last pass did not see, or
 * an end. An end is written to the summary here, so a loop that is killed
 * right after still left the change request saying why it stopped.
 */
export async function waitForEvent(
  forge: ReviewForge,
  repo: RepoId,
  ref: string,
  opts: WaitOptions,
): Promise<WaitEvent> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? realNow;
  const start = now();
  for (;;) {
    const cr = await forge.get(repo, ref);
    const ctx = { forge, repo, cr };
    const st = await readState(ctx);
    const status = st.summary?.marker.state;
    if (cr.state === "merged" || cr.state === "closed") {
      if (st.summary && status !== cr.state) await mark(ctx, st, cr.state);
      return { event: cr.state, head: cr.head };
    }
    if (status === "stopped") return { event: "stopped", head: cr.head };
    if (st.stop) {
      await mark(ctx, st, "stopped");
      return { event: "stopped", head: cr.head, why: st.stop };
    }
    if (!st.summary) return { event: "push", since: null, head: cr.head };
    if (st.summary.marker.head !== cr.head)
      return { event: "push", since: st.summary.marker.head, head: cr.head };
    if (now() - start + opts.interval > opts.timeout) return { event: "none", head: cr.head };
    await sleep(opts.interval);
  }
}
