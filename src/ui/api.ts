import type { ReviewState, Thread, Decision, ThreadTarget } from "../store.js";
import type { CompiledDocument, CompiledMap } from "../document/compile.js";
import type { Coverage } from "../coverage.js";
import type { FileDiff } from "../diff.js";
import type { ChangedFile, Commit } from "../git.js";
import type { SymbolDef } from "../symbols.js";
import type { Presence } from "../presence.js";
import type { QueueRow } from "../queue.js";

export interface Payload {
  review: ReviewState;
  revision: number;
  document: CompiledDocument | null;
  map: CompiledMap | null;
  changes: ChangedFile[];
  /** explainers only: what the document examined at the pinned commit, and what it did not */
  coverage: Coverage | null;
  meta: { revision: number; at: string; title: string; hasMap: boolean; theme?: string } | null;
  theme: { name: string; source?: string; css: string } | null;
  threads: Thread[];
  decisions: Decision[];
  /** whether an agent is listening to this document right now */
  agent: Presence;
}

export interface FileLines {
  path: string;
  graph: "head" | "base";
  lang: string;
  total: number;
  from: number;
  to: number;
  lines: string[];
}

/**
 * A page written by `thurview export` carries its data in place of a server:
 * the document, commits, diffs and the whole of every file it shows. Null when
 * the page is served, which is every other time.
 */
export interface Snapshot {
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

/** What a published page answers for `url`, or throws: it has no server to ask. */
function offline<T>(url: string): T {
  const snap = published!;
  const u = new URL(url, "http://published.invalid");
  const sub = u.pathname.split("/").filter(Boolean)[3];
  const path = u.searchParams.get("path") ?? "";
  const answer =
    sub === undefined
      ? snap.payload
      : sub === "commits"
        ? snap.commits
        : sub === "presence"
          ? snap.payload.agent
          : sub === "diff"
            ? snap.diffs[path]
            : sub === "file"
              ? sliceLines(snap.files[`${u.searchParams.get("graph")}:${path}`], u.searchParams)
              : undefined;
  if (answer === undefined) throw new Error("not in this published copy");
  return answer as T;
}

function sliceLines(f: FileLines | undefined, q: URLSearchParams): FileLines | undefined {
  if (!f) return undefined;
  const from = Math.max(1, Number(q.get("from") ?? 1));
  const to = Math.min(f.total, Number(q.get("to") ?? f.total));
  return { ...f, from, to, lines: f.lines.slice(from - 1, to) };
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  if (published) {
    if (init?.method && init.method !== "GET") throw new Error("a published copy is read only");
    return offline<T>(url);
  }
  const r = await fetch(url, init);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return j<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  reviews: () => j<(ReviewState & { openThreads: number; queue: QueueRow })[]>("/api/reviews"),
  review: (id: string, revision?: number) =>
    j<Payload>(`/api/reviews/${id}${revision ? `?revision=${revision}` : ""}`),
  revisions: (id: string) =>
    j<{ revision: number; at: string; title: string }[]>(`/api/reviews/${id}/revisions`),
  commits: (id: string) => j<Commit[]>(`/api/reviews/${id}/commits`),
  presence: (id: string) => j<Presence>(`/api/reviews/${id}/presence`),
  diff: (id: string, path: string) =>
    j<FileDiff>(`/api/reviews/${id}/diff?path=${encodeURIComponent(path)}`),
  file: (id: string, path: string, graph: "head" | "base", from?: number, to?: number) =>
    j<FileLines>(
      `/api/reviews/${id}/file?path=${encodeURIComponent(path)}&graph=${graph}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`,
    ),
  symbols: (id: string, name: string, graph: "head" | "base") =>
    j<SymbolDef[]>(`/api/reviews/${id}/symbols?name=${encodeURIComponent(name)}&graph=${graph}`),
  createThread: (
    id: string,
    input: {
      kind: "question" | "comment";
      mode: "ask" | "review";
      target: ThreadTarget;
      body: string;
    },
  ) => post<Thread>(`/api/reviews/${id}/threads`, input),
  reply: (id: string, tid: string, body: string) =>
    post<Thread>(`/api/reviews/${id}/threads/${tid}/reply`, { body, role: "reviewer" }),
  resolve: (id: string, tid: string) =>
    post<Thread>(`/api/reviews/${id}/threads/${tid}/resolve`, {}),
  reopen: (id: string, tid: string) => post<Thread>(`/api/reviews/${id}/threads/${tid}/reopen`, {}),
  deleteThread: (id: string, tid: string) =>
    post<{ ok: true }>(`/api/reviews/${id}/threads/${tid}/delete`, {}),
  submit: (id: string, decision: "approve" | "request-changes" | "close", body: string) =>
    post<{ review: ReviewState }>(`/api/reviews/${id}/submit`, { decision, body }),
  dismiss: (id: string, dismissed: boolean) =>
    post<ReviewState>(`/api/reviews/${id}/dismiss`, { dismissed }),
  remove: (id: string) => j<{ ok: true }>(`/api/reviews/${id}`, { method: "DELETE" }),
};
