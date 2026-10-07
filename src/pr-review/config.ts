import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AxiError } from "axi-sdk-js";
import { home } from "../store.js";
import { qualified, type RepoId } from "../forge/types.js";

const AutoMerge = z
  .object({
    method: z.literal("squash").default("squash"),
    repositories: z.array(z.string().regex(/^[^/\s:]+\/[^\s*?]+\/[^\s*?]+$/)).default([]),
  })
  .strict();

/** Only the user's publishing store can grant merge authority. */
export async function autoMergeAllowed(repo: RepoId): Promise<boolean> {
  const file = join(home(), "publish.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AxiError("publish.yaml is unreadable", "VALIDATION_ERROR", [
      "Check the user-owned publishing configuration",
    ]);
  }
  try {
    const config = z.object({ auto_merge: AutoMerge.optional() }).parse(parse(text) ?? {});
    return (config.auto_merge?.repositories ?? []).some(
      (r) => r.toLowerCase() === qualified(repo).toLowerCase(),
    );
  } catch {
    throw new AxiError("publish.yaml has invalid auto_merge configuration", "VALIDATION_ERROR", [
      "Use auto_merge: { method: squash, repositories: [host/owner/repo] }; omit it to disable",
    ]);
  }
}
