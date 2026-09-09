import type { Payload } from "./api.js";
import type { DocumentKind, Thread, ThreadTarget } from "../store.js";

export type View = "review" | "commits" | "files" | "map" | "coverage";

/**
 * The tabs a document kind has. A review is a CHANGE, so the diff, the commits
 * and the interface delta all mean something. An explainer is a CODEBASE at one
 * commit: those three would render an empty claim about a change that does not
 * exist, so they are absent, and Coverage - what the document reached and what
 * it did not - takes their place.
 */
export const VIEWS: Record<DocumentKind, View[]> = {
  review: ["review", "commits", "files", "map"],
  explainer: ["review", "map", "coverage"],
};

export function kind(): DocumentKind {
  return state.data?.review.kind === "explainer" ? "explainer" : "review";
}

/** The current view, or the document's first tab when this kind has no such tab. */
export function view(): View {
  const allowed = VIEWS[kind()];
  return allowed.includes(state.view) ? state.view : allowed[0]!;
}

export interface SideState {
  kind: "none" | "peek" | "threads";
  anchor?: string;
  activeThread?: string;
}

export interface State {
  id: string;
  data: Payload | null;
  view: View;
  params: URLSearchParams;
  side: SideState;
  /** revision being viewed when older than the presented one */
  viewingRevision: number | null;
  latestRevision: number | null;
  splitDiff: boolean;
}

/** Below this the UI is one column: no TOC rail, no split diff, side as overlay. */
export const NARROW = "(max-width: 900px)";
export function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

export const state: State = {
  id: "",
  data: null,
  view: "review",
  params: new URLSearchParams(),
  side: { kind: "none" },
  viewingRevision: null,
  latestRevision: null,
  splitDiff: localStorage.getItem("thurview.split") !== "0",
};

type Listener = () => void;
const listeners: Record<string, Listener[]> = {};
export function on(event: "data" | "threads" | "view" | "side", fn: Listener): void {
  (listeners[event] ??= []).push(fn);
}
export function emit(event: "data" | "threads" | "view" | "side"): void {
  for (const fn of listeners[event] ?? []) fn();
}

export function threadsFor(target: (t: ThreadTarget) => boolean): Thread[] {
  return (state.data?.threads ?? []).filter((t) => target(t.target));
}

export function describeTarget(t: ThreadTarget): string {
  if (t.type === "document") return "document";
  if (t.type === "file") {
    if (!t.line) return `${t.path} (file)`;
    const range = t.endLine && t.endLine > t.line ? `${t.line}-${t.endLine}` : String(t.line);
    return `${t.path}:${range}${t.side === "base" ? " (base)" : ""}`;
  }
  if (t.type === "map") return `map · ${t.node}`;
  return "review";
}

export function navigate(
  view: View,
  params: Record<string, string | number | undefined> = {},
): void {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const q = p.toString();
  location.hash = `#/${view}${q ? `?${q}` : ""}`;
}

export function readHash(): void {
  const m = /^#\/(\w+)(?:\?(.*))?$/.exec(location.hash);
  const v = (m?.[1] ?? "review") as View;
  state.view = (["review", "commits", "files", "map", "coverage"] as View[]).includes(v)
    ? v
    : "review";
  state.params = new URLSearchParams(m?.[2] ?? "");
}

export function isTerminal(): boolean {
  const s = state.data?.review.status;
  return s === "accepted" || s === "closed";
}

export function readOnly(): boolean {
  return isTerminal() || state.viewingRevision !== null;
}
