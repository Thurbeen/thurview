import { createHash } from "node:crypto";
import { z } from "zod";
import { AxiError } from "axi-sdk-js";
import {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITIES,
  type Category,
  type Severity,
} from "./categories.js";

/**
 * What a change request review posts, and how it reads it back. Everything a
 * follow loop needs to resume lives in two hidden markers on the forge - one
 * on the summary, one on each finding's thread - so a restart reads the state
 * back from the change request and never from this machine.
 */

/** Authored summary prose budget; generated rows, labels, links and metadata are separate. */
export const SUMMARY_WORDS = 120;
/** A finding's visible lines, its suggestion block excluded and its sign-off included. */
export const FINDING_LINES = 5;

const SUMMARY_TAG = "thurview-pr-review";
const FINDING_TAG = "thurview-finding";

export type ReviewStatus = "active" | "stopped" | "merged" | "closed";

export interface SummaryMarker {
  /** The head the last pass reviewed; a push is a head that differs from it. */
  head: string;
  state: ReviewStatus;
  /** The newest note id already read, so an old stop command stops nothing. */
  seen: string;
}

export interface FindingMarker {
  id: string;
  category: Category;
  severity: Severity;
}

const Finding = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  category: z.enum(CATEGORY_IDS),
  severity: z.enum(SEVERITIES),
  path: z.string().min(1),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  side: z.enum(["head", "base"]).optional(),
  title: z.string().min(1),
  body: z.string().default(""),
  suggestion: z.string().optional(),
});

const PassSchema = z.object({
  /** The head this pass reviewed; `sync` refuses it once the change request moved on. */
  head: z.string().min(7),
  confidence: z.number().int().min(1).max(5),
  reason: z.string().min(1),
  risk: z.array(z.string().min(1)).min(1).max(5),
  change: z.string().min(1),
  reviewUrl: z.string().url().optional(),
  markdownUrl: z.string().url().optional(),
  signoff: z.string().optional(),
  findings: z.array(Finding).default([]),
  fixed: z.array(z.string()).default([]),
});

export type Finding = z.input<typeof Finding>;
export type Pass = z.input<typeof PassSchema>;

export function parsePass(text: string, file: string): Pass {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AxiError(`${file} is not valid JSON: ${(e as Error).message}`, "VALIDATION_ERROR", [
      "Read `thurview pr-review --help` for the pass file's shape",
    ]);
  }
  const parsed = PassSchema.safeParse(raw);
  if (!parsed.success)
    throw new AxiError(
      `${file} is not a pass: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
      "VALIDATION_ERROR",
      [
        `category is one of ${CATEGORY_IDS.join(", ")}; severity is one of ${SEVERITIES.join(", ")}`,
        "confidence is 1-5; risk holds 1 to 5 bullets",
      ],
    );
  checkPass(parsed.data);
  return parsed.data;
}

/** The rules no schema says: one line per title, and the comment budget. */
export function checkPass(p: Pass): void {
  // A newline would let a line pass as a table row or the marker, and so
  // slip past the word budget; every one of these is one line by design.
  const oneLine: [string, string | undefined][] = [
    ["reason", p.reason],
    ["change", p.change],
    ["signoff", p.signoff],
    ...p.risk.map((r, i): [string, string] => [`risk[${i}]`, r]),
  ];
  for (const [field, text] of oneLine)
    if (text && /[\r\n]/.test(text.trim()))
      throw new AxiError(`${field} is more than one line`, "VALIDATION_ERROR", [
        "reason, each risk bullet, change and signoff are one line each",
      ]);
  for (const f of p.findings ?? []) {
    const at = `${f.path}:${f.line}`;
    if (f.title.includes("\n"))
      throw new AxiError(`${at}: the title is more than one line`, "VALIDATION_ERROR", [
        "The title is the claim, in one line; the fix goes in body",
      ]);
    if (f.startLine && f.startLine > f.line)
      throw new AxiError(`${at}: startLine ${f.startLine} is after line`, "VALIDATION_ERROR", [
        "line is the LAST line of the range and startLine the first",
      ]);
    const lines = visibleLines(f, p.signoff);
    if (lines > FINDING_LINES)
      throw new AxiError(
        `${at}: the comment is ${lines} lines, over the ${FINDING_LINES}-line budget`,
        "VALIDATION_ERROR",
        ["One point per comment: cut it to the claim and one fix, or split it in two"],
      );
  }
}

function visibleLines(f: Finding, signoff?: string): number {
  const body = f.body?.trim() ? f.body.trim().split("\n").length : 0;
  return 1 + body + (signoff ? 1 : 0);
}

/** Stable across passes, so the same finding found twice is recognised as one. */
export function findingId(f: Finding): string {
  if (f.id) return f.id;
  const h = createHash("sha1").update(`${f.category}\n${f.path}\n${f.title.trim()}`);
  return h.digest("hex").slice(0, 10);
}

function marker(tag: string, data: object): string {
  return `<!-- ${tag} ${JSON.stringify(data)} -->`;
}

function readMarker<T>(tag: string, body: string): T | null {
  const m = new RegExp(`^<!-- ${tag} (\\{.*?\\}) -->`).exec(body);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

export function readSummaryMarker(body: string): SummaryMarker | null {
  return readMarker<SummaryMarker>(SUMMARY_TAG, body);
}

export function readFindingMarker(body: string): (FindingMarker & { title: string }) | null {
  const m = readMarker<FindingMarker>(FINDING_TAG, body);
  if (!m || !(m.category in CATEGORIES) || !SEVERITIES.includes(m.severity)) return null;
  const heading = body.split("\n")[1] ?? "";
  return { ...m, title: heading.replace(/^.*?:\*\* /, "") };
}

/**
 * One finding as an inline comment: the claim, the fix, a suggestion the
 * author can apply. GitHub anchors a range and replaces all of it; GitLab
 * anchors the range's last line, so its suggestion reaches back over the rest.
 */
export function renderFinding(f: Finding, signoff: string | undefined, forge: string): string {
  const label = CATEGORIES[f.category].label;
  const head =
    f.severity === "nit"
      ? `nit: **${label}:** ${f.title.trim()}`
      : `**${label} · ${f.severity}:** ${f.title.trim()}`;
  const parts = [
    marker(FINDING_TAG, { id: findingId(f), category: f.category, severity: f.severity }),
    head,
  ];
  if (f.body?.trim()) parts.push(f.body.trim());
  if (f.suggestion !== undefined) {
    const above = f.startLine && f.startLine < f.line ? f.line - f.startLine : 0;
    const fence = forge === "gitlab" ? `\`\`\`suggestion:-${above}+0` : "```suggestion";
    parts.push(`${fence}\n${f.suggestion.replace(/\n$/, "")}\n\`\`\``);
  }
  if (signoff) parts.push(signoff);
  return parts.join("\n");
}

export interface OpenFinding {
  id?: string;
  category: Category;
  severity: Severity;
  title?: string;
  path?: string;
  line?: number;
  url?: string;
}

export interface SummaryUpdate {
  first: boolean;
  counts: { resolved: number; new: number; stillOpen: number };
  flagged?: string[];
  reviewedAt: string;
}

function tableText(text: string): string {
  return text
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]/g, " ");
}

function code(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((s) => s.length)) + 1);
  return `${fence}${text}${fence}`;
}

function table(open: OpenFinding[]): string {
  if (!open.length) return "No open findings.";
  const rows = [...open]
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .map((f) => {
      const severity =
        f.severity === "non-blocking"
          ? "Non-blocking"
          : f.severity === "blocking"
            ? "Blocking"
            : "Nit";
      const location = f.path
        ? code(
            `${f.path}${f.line ? `:${f.line}` : ""}`.replace(/\|/g, "\\|").replace(/[\r\n]/g, " "),
          )
        : "Location unavailable";
      const thread = f.url
        ? `[${location}](${f.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`
        : location;
      return `| **${severity} · ${CATEGORIES[f.category].label}:** ${tableText(f.title ?? "Finding")} | ${thread} |`;
    });
  return ["| Finding at reviewed head | Thread |", "| --- | --- |", ...rows].join("\n");
}

function headline(p: Pass, author: string, open: OpenFinding[]): string {
  const blocking = open.filter((f) => f.severity === "blocking").length;
  const score = `Confidence ${p.confidence}/5`;
  if (blocking)
    return `Next: @${author} — **${score} · do not merge; fix the ${blocking} blocking finding${blocking === 1 ? "" : "s"}.**`;
  if (p.confidence === 5) return `Next: merge — **${score} · no blocking findings.**`;
  if (p.confidence === 4 && open.some((f) => f.severity === "non-blocking"))
    return `Next: @${author} — **${score} · look at the non-blocking findings before merge.**`;
  return `Next: @${author} — **${score} · answer the risk before merge.**`;
}

/** The line a stopped or finished review opens with instead of a next step. */
export function statusLine(m: SummaryMarker): string | null {
  const at = m.head.slice(0, 7);
  if (m.state === "stopped")
    return `Review stopped at ${at}. Remove the \`thurview:stop\` label and run \`thurview pr-review start\` to resume.`;
  if (m.state === "merged" || m.state === "closed") return `Review ended: ${m.state} at ${at}.`;
  return null;
}

/** Count every authored word, including folded prose and Markdown-looking lines. */
export function summaryWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The compact summary keeps the action visible and folds context and update history. */
export function renderSummary(
  p: Pass,
  m: SummaryMarker,
  author: string,
  open: OpenFinding[],
  update?: SummaryUpdate,
): string {
  // Count the inputs, not rendered lines: a pipe or HTML cannot hide prose from the budget.
  const words = summaryWords([p.reason, p.change, ...p.risk, p.signoff ?? ""].join(" "));
  if (words > SUMMARY_WORDS)
    throw new AxiError(
      `the summary prose is ${words} words, over the ${SUMMARY_WORDS}-word budget`,
      "VALIDATION_ERROR",
      ["Cut reason, risk, change and signoff; folded prose still counts"],
    );
  const links: string[] = [];
  if (p.reviewUrl) links.push(`[**Full review**](${p.reviewUrl})`);
  if (p.markdownUrl) links.push(`[Markdown export](${p.markdownUrl})`);
  const parts = [
    `${marker(SUMMARY_TAG, m)}\n${statusLine(m) ?? headline(p, author, open)}`,
    ...(links.length ? [links.join(" · ")] : []),
    p.reason.trim(),
    table(open),
  ];
  if (update) {
    const c = update.counts;
    parts.push(
      update.first
        ? `First review: ${c.new} new finding${c.new === 1 ? "" : "s"}.`
        : `<details>\n<summary>Since this review: ${c.resolved} resolved · ${c.new} new · ${c.stillOpen} still open</summary>\n\nCounts are from this pass against the reviewed head.\n\n</details>`,
    );
    if (update.flagged?.length)
      parts.push(
        `Resolved on forge but still present: ${update.flagged.map(tableText).join(", ")}.`,
      );
  }
  parts.push(
    `<details>\n<summary>Change and risks</summary>\n\n**Change:** ${p.change.trim()}\n\n**Risk**\n\n${p.risk.map((r) => `- ${r.trim()}`).join("\n")}\n\n</details>`,
  );
  parts.push(`Reviewed ${code(m.head.slice(0, 7))}${update ? ` · ${update.reviewedAt}` : ""}`);
  if (p.signoff) parts.push(p.signoff.trim());
  return parts.join("\n\n");
}

/** Status changes keep the reviewed confidence, without the previous next action. */
export function restate(body: string, m: SummaryMarker, opening: string): string {
  const lines = body.split("\n");
  const confidence = lines[1]?.match(/\bConfidence [1-5]\/5\b/)?.[0];
  const line = confidence ? `${opening} · **${confidence}**` : opening;
  return [marker(SUMMARY_TAG, m), line, ...lines.slice(2)].join("\n");
}

export function bareSummary(m: SummaryMarker, opening: string): string {
  return `${marker(SUMMARY_TAG, m)}\n${opening}`;
}
