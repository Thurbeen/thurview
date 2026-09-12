import { AxiError } from "axi-sdk-js";
import * as g from "../git.js";
import { GitHubForge, parseRemote } from "./github.js";
import { GitLabForge } from "./gitlab.js";
import type { Check, CheckState, Forge, RepoId } from "./types.js";

export * from "./types.js";
export { parseRemote };

const BUILTIN: Forge[] = [new GitHubForge(), new GitLabForge()];

export function forgeById(id: string): Forge {
  const f = BUILTIN.find((x) => x.id === id);
  if (!f)
    throw new AxiError(`unknown forge ${id}`, "VALIDATION_ERROR", [
      `--forge takes ${BUILTIN.map((x) => x.id).join(" or ")}`,
    ]);
  return f;
}

/**
 * Which adapter owns a host. `github.com` and `gitlab.com` are decided by
 * name; every other host is asked of the machine, because a self-hosted
 * instance is the normal case and its name says nothing. A host no adapter
 * claims is REFUSED rather than guessed at - guessing wrong means posting a
 * review on somebody else's repository.
 */
export async function forgeFor(host: string, explicit?: string): Promise<Forge> {
  if (explicit) return forgeById(explicit);
  for (const f of BUILTIN) if (await f.owns(host)) return f;
  throw new AxiError(`no forge configured for ${host}`, "FORGE_ERROR", [
    `Authenticate the host (\`gh auth login --hostname ${host}\` or \`glab auth login --hostname ${host}\`)`,
    `Or pass --forge ${BUILTIN.map((x) => x.id).join("|")} to name it`,
  ]);
}

/** The repository this worktree's `origin` points at. */
export async function repoOf(worktree: string, explicit?: string): Promise<RepoId> {
  if (explicit) {
    const parts = explicit.split("/").filter(Boolean);
    if (parts.length < 2)
      throw new AxiError(`${explicit} is not a host-qualified repository`, "VALIDATION_ERROR", [
        "--repo takes host/path, as in github.com/owner/repo",
      ]);
    return { host: parts[0]!, path: parts.slice(1).join("/") };
  }
  const url = (await g.git(worktree, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const repo = url ? parseRemote(url) : null;
  if (!repo)
    throw new AxiError("could not read a forge repository from `origin`", "FORGE_ERROR", [
      "Pass --repo host/path, as in github.com/owner/repo",
    ]);
  return repo;
}

export interface CiSummary {
  /** True only when every check ran and passed, and none is missing against the baseline. */
  trustworthy: boolean;
  verdict: string;
  ran: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  running: number;
  unknown: number;
  /** null when the target branch's own checks could not be read. */
  baselineRan: number | null;
  baselineBranch: string;
}

function count(checks: Check[], state: CheckState): number {
  return checks.filter((c) => c.state === state).length;
}

/**
 * What CI actually established, in one sentence the review can quote.
 *
 * Two failures this answers, both of which shipped bugs before it existed: a
 * change request from a fork runs a fraction of the checks an internal branch
 * runs, and a cancelled job reads as "no failures" in every summary view. So
 * the count that matters is not "did anything fail" but "how much ran here
 * against how much runs on the branch this would merge into".
 */
export function summariseCi(
  checks: Check[],
  baseline: Check[] | null,
  baselineBranch: string,
): CiSummary {
  const s: CiSummary = {
    trustworthy: false,
    verdict: "",
    ran: checks.length,
    passed: count(checks, "passed"),
    failed: count(checks, "failed"),
    cancelled: count(checks, "cancelled"),
    skipped: count(checks, "skipped"),
    running: count(checks, "running"),
    unknown: count(checks, "unknown"),
    baselineRan: baseline ? baseline.length : null,
    baselineBranch,
  };
  const missing = s.baselineRan === null ? null : s.baselineRan - s.ran;
  const parts: string[] = [];
  if (!s.ran) parts.push("No check ran on this head");
  else parts.push(`${s.passed} of ${s.ran} checks passed`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.cancelled) parts.push(`${s.cancelled} were cancelled, so they asserted nothing`);
  if (s.skipped) parts.push(`${s.skipped} never ran`);
  if (s.running) parts.push(`${s.running} are still running`);
  if (s.unknown) parts.push(`${s.unknown} could not be read`);
  if (missing === null)
    parts.push(
      `what ${baselineBranch} itself runs could not be read, so nothing here says how much CI is missing`,
    );
  else if (missing > 0)
    parts.push(`${baselineBranch} runs ${s.baselineRan}, so ${missing} of them are absent here`);
  s.trustworthy =
    s.ran > 0 &&
    s.failed === 0 &&
    s.cancelled === 0 &&
    s.running === 0 &&
    s.unknown === 0 &&
    missing !== null &&
    missing <= 0;
  parts.push(
    s.trustworthy ? "CI is a real gate on this change" : "CI is not a gate here; the review is",
  );
  s.verdict = parts.join("; ") + ".";
  return s;
}
