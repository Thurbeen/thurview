import type { ReviewState, Thread, Decision, ThreadTarget } from "../store.js";
import type { CompiledDocument, CompiledMap } from "../document/compile.js";
import type { FileDiff } from "../diff.js";
import type { ChangedFile, Commit } from "../git.js";
import type { SymbolDef } from "../symbols.js";

export interface Payload {
  review: ReviewState;
  revision: number;
  document: CompiledDocument | null;
  map: CompiledMap | null;
  changes: ChangedFile[];
  meta: { revision: number; at: string; title: string; hasMap: boolean; theme?: string } | null;
  theme: { name: string; source?: string; css: string } | null;
  threads: Thread[];
  decisions: Decision[];
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

async function j<T>(url: string, init?: RequestInit): Promise<T> {
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
  reviews: () => j<(ReviewState & { openThreads: number })[]>("/api/reviews"),
  review: (id: string, revision?: number) =>
    j<Payload>(`/api/reviews/${id}${revision ? `?revision=${revision}` : ""}`),
  revisions: (id: string) =>
    j<{ revision: number; at: string; title: string }[]>(`/api/reviews/${id}/revisions`),
  commits: (id: string) => j<Commit[]>(`/api/reviews/${id}/commits`),
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
