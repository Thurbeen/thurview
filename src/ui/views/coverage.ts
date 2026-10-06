/**
 * What the explainer examined, and what it did not.
 *
 * A review is bounded by its diff; a codebase is not. So this tab exists to
 * make the bound of an explainer a stated fact rather than something the reader
 * has to infer from what the prose happens to mention. Everything here is
 * derived at publish from what the agent did that can be checked at the pinned
 * commit - its anchors, its map's globs, and the searches it recorded, re-run
 * there - as counts and lists of named things, nothing graded.
 */
import { h, append } from "../dom.js";
import { state, navigate } from "../state.js";
import { openAnchorPeek } from "../code.js";
import type { Coverage, ClusterCoverage, FileState, SearchRecord } from "../../coverage.js";

const SHOWN = 8;

const LABELS: [FileState, string][] = [
  ["explained", "anchored in the document"],
  ["placed", "placed on the map only"],
  ["searched", "matched by a recorded search only"],
  ["uncovered", "not examined"],
];

export function renderCoverage(root: HTMLElement): void {
  const cov = state.data?.coverage;
  if (!cov) {
    append(root, [
      h(
        "div",
        { class: "empty-state" },
        h("p", null, "No coverage recorded for this revision."),
        h("p", null, "Coverage is derived when an explainer is published."),
      ),
    ]);
    return;
  }
  append(root, [intro(cov), searches(cov), clusters(cov), owners(cov)]);
}

/** A revision sealed before searches were counted has no such state. */
const count = (cov: Coverage, s: FileState) => cov.states[s] ?? 0;

function bar(cov: Coverage): HTMLElement {
  const total = Math.max(cov.files.total, 1);
  const seg = (n: number, cls: string, label: string) =>
    n
      ? h("span", {
          class: `cov-seg ${cls}`,
          style: { width: `${(n / total) * 100}%` },
          title: `${n} ${label}`,
        })
      : null;
  return h(
    "div",
    { class: "cov-bar" },
    LABELS.map(([s, label]) => seg(count(cov, s), s, label)),
  );
}

function intro(cov: Coverage): HTMLElement {
  return h(
    "div",
    { class: "cov-intro" },
    h("h2", null, "What this explainer covers"),
    h(
      "p",
      null,
      "A codebase does not fit in a short document, so this one selects. Here is the",
      " selection, counted rather than claimed: every file in scope at the pinned commit,",
      " and which of the four states it is in.",
    ),
    bar(cov),
    h(
      "div",
      { class: "cov-key" },
      LABELS.map(([s, label]) =>
        h(
          "span",
          { class: "cov-key-item" },
          h("i", { class: `cov-dot ${s}` }),
          `${count(cov, s)} ${label}`,
        ),
      ),
    ),
    h(
      "div",
      { class: "cov-facts" },
      fact("scope", cov.scope === "**" ? "the whole repository" : cov.scope),
      fact("commit", cov.commit.slice(0, 12)),
      fact("files in scope", String(cov.files.total)),
    ),
  );
}

function fact(label: string, value: string): HTMLElement {
  return h("div", { class: "cov-fact" }, h("b", null, value), h("span", { class: "muted" }, label));
}

function fileList(files: string[], cls: string): HTMLElement | null {
  if (!files.length) return null;
  const wrap = h("div", { class: `cov-files ${cls}` });
  const chip = (f: string) =>
    h("code", { class: "cov-file", title: f }, f.split("/").slice(-2).join("/"));
  files.slice(0, SHOWN).forEach((f) => wrap.appendChild(chip(f)));
  const rest = files.slice(SHOWN);
  if (rest.length) {
    const more = h(
      "button",
      {
        class: "small ghost",
        onclick: () => more.replaceWith(...rest.map(chip)),
      },
      `show ${rest.length} more`,
    );
    wrap.appendChild(more);
  }
  return wrap;
}

/** The line a reader runs to check a search: the same one publish ran. */
function command(cov: Coverage, s: SearchRecord): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const paths = s.paths.map((p) => ` ${quote(`:(glob)${p}`)}`).join("");
  return `git grep -I -n -E -e ${quote(s.pattern)} ${cov.commit.slice(0, 12)} --${paths}`;
}

function searches(cov: Coverage): HTMLElement | null {
  const list = cov.searches ?? [];
  if (!list.length) return null;
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "What the agent searched"),
    h(
      "p",
      { class: "muted" },
      "Each search the agent recorded, re-run at the pinned commit. A search that matched",
      " nothing is listed too: that zero is what a claim like “nothing else calls it” rests on.",
    ),
    h(
      "div",
      { class: "cov-links" },
      list.map((s) =>
        h(
          "div",
          { class: "cov-link" },
          h("code", null, s.key),
          s.why ? h("span", null, s.why) : null,
          h(
            "span",
            { class: "muted mono" },
            `${s.hits} line${s.hits === 1 ? "" : "s"} in ${s.files.length} file${s.files.length === 1 ? "" : "s"}`,
          ),
          h("code", { class: "muted" }, command(cov, s)),
          fileList(s.files, "searched"),
        ),
      ),
    ),
  );
}

function clusterRow(c: ClusterCoverage): HTMLElement {
  const anchors = state.data?.document?.anchors ?? {};
  const firstAnchor = c.explained.length
    ? Object.values(anchors).find((a) => a.peek && c.explained.includes(a.peek.file))
    : undefined;
  const badge = (files: string[] | undefined, cls: string, label: string) =>
    files?.length ? h("span", { class: `badge cov-b-${cls}` }, `${files.length} ${label}`) : null;
  return h(
    "div",
    { class: "cov-cluster" },
    h(
      "div",
      { class: "cov-cluster-head" },
      h("code", { class: "cov-label" }, c.label),
      h("span", { class: "muted" }, `${c.files} files`),
      h("span", { class: "spacer" }),
      badge(c.explained, "explained", "anchored"),
      badge(c.placed, "placed", "placed"),
      badge(c.searched, "searched", "searched"),
      badge(c.uncovered, "uncovered", "not examined"),
      firstAnchor
        ? h("button", { class: "small", onclick: () => openAnchorPeek(firstAnchor) }, "Peek code ▸")
        : null,
    ),
    fileList(c.uncovered, "uncovered"),
  );
}

function clusters(cov: Coverage): HTMLElement {
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "By directory"),
    h(
      "p",
      { class: "muted" },
      "The files in scope by the directory they sit in, largest first.",
      " The files listed under a directory are the ones nothing in this explainer reached.",
    ),
    cov.clusters.map(clusterRow),
  );
}

function owners(cov: Coverage): HTMLElement | null {
  if (!cov.owners.length) return null;
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "What each map node owns"),
    h(
      "p",
      { class: "muted" },
      "A file counts as placed because a map node's globs match it. The globs are here",
      " so a broad one is visible rather than silently inflating the count.",
    ),
    h(
      "div",
      { class: "cov-links" },
      cov.owners.map((o) =>
        h(
          "div",
          {
            class: "cov-link",
            onclick: () => navigate("map", { node: o.node }),
            style: { cursor: "pointer" },
          },
          h("code", null, o.node),
          h("span", { class: "muted" }, o.globs.join(" ")),
          h("span", { class: "muted mono" }, `${o.files} files`),
        ),
      ),
    ),
  );
}
