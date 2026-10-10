import type { Commit } from "../git.js";
import type { FileDiff } from "../diff.js";
import type { Payload, FileLines } from "./api.js";

/**
 * A page written by `thurview export` carries its data in place of a server:
 * the document, commits, diffs and the whole of every file it shows. Null when
 * the page is served, which is every other time.
 */
export interface Snapshot {
  banner?: { revision: number; sha: string; liveUrl?: string };
  markdown?: string;
  /** what was sent, as `thurview export --format md` writes it */
  feedback?: string;
  payload: Payload;
  commits: Commit[];
  diffs: Record<string, FileDiff>;
  /** keyed `head:<path>` or `base:<path>`, every line of the file */
  files: Record<string, FileLines>;
}

export const published: Snapshot | null = (() => {
  const el = document.getElementById("thurview-snapshot");
  return el?.textContent ? (JSON.parse(el.textContent) as Snapshot) : null;
})();
