/**
 * The interface delta: what the change did to the surfaces other code can reach.
 *
 * A capability becomes real when it becomes visible, so the honest answer to
 * "what does this pull request do" is what it added to, changed in, or took out
 * of the surfaces a consumer reaches: an exported function, a CLI flag, an HTTP
 * route, a config key, a file format. The agent declares each one in
 * `data.yaml`, and publish holds every entry to an anchor on lines the pinned
 * diff really added or deleted, so an entry cannot be manufactured or outlive
 * the code that moved it.
 */
export interface InterfaceEntry {
  /** `authored:<key>` for a review's entry, `proposed:<key>` for a design's */
  id: string;
  change: "added" | "changed" | "removed";
  /** what a consumer names it, in the agent's own words */
  name: string;
  /** kept for revisions sealed while thurview derived entries; always empty now */
  was: string;
  kind: string;
  file: string;
  line: number;
  /** which pinned commit `file` and `line` belong to */
  graph: "head" | "base";
  /** what this lets a consumer do, written by the agent */
  capability?: string;
  /** the anchor that proves the entry is in this diff, or names a design's site */
  anchor?: string;
}

export interface InterfaceDelta {
  entries: InterfaceEntry[];
  /** the whole answer in one sentence, for the agent and the reader alike */
  verdict: string;
}

const RANK: Record<InterfaceEntry["change"], number> = { removed: 0, changed: 1, added: 2 };

/** Removed first: it is the entry a reviewer must not miss. */
export function sortEntries(entries: InterfaceEntry[]): InterfaceEntry[] {
  return entries.sort(
    (a, b) =>
      RANK[a.change] - RANK[b.change] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.name.localeCompare(b.name),
  );
}

/** The counts per change, removed first, or null when there is no entry. */
export function countsOf(entries: InterfaceEntry[]): string | null {
  const counts = (["removed", "changed", "added"] as const)
    .map((c) => [c, entries.filter((e) => e.change === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${c}`);
  return counts.length ? counts.join(", ") : null;
}
