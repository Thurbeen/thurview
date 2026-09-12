import { z } from "zod";
import { AxiError } from "axi-sdk-js";
import type { Submission } from "./types.js";

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
