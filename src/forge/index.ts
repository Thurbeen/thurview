import { AxiError } from "axi-sdk-js";
import * as g from "../git.js";
import { GitHubForge, parseRemote } from "./github.js";
import { GitLabForge } from "./gitlab.js";
import type { Forge, RepoId } from "./types.js";

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
