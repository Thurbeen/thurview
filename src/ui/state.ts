import type { Payload } from "./api.js";
import type { Thread, ThreadTarget } from "../store.js";

export type View = "review" | "commits" | "files" | "map";

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
  const view = (m?.[1] ?? "review") as View;
  state.view = ["review", "commits", "files", "map"].includes(view) ? view : "review";
  state.params = new URLSearchParams(m?.[2] ?? "");
}

export function isTerminal(): boolean {
  const s = state.data?.review.status;
  return s === "accepted" || s === "closed";
}

export function readOnly(): boolean {
  return isTerminal() || state.viewingRevision !== null;
}
