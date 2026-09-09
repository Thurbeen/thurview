/**
 * What the explainer examined, and what it did not.
 *
 * A review is bounded by its diff; a codebase is not. So this tab exists to
 * make the bound of an explainer a stated fact rather than something the reader
 * has to infer from what the prose happens to mention. Everything here is
 * derived at publish from the code graph at the pinned commit: counts and lists
 * of named things, nothing graded. Where a number invites a conclusion - a part
 * everything reaches, a name defined in four places, a link that runs both ways
 * - drawing it is the reader's job, and this page deliberately stops short.
 */
import { h, append } from "../dom.js";
import { state, navigate } from "../state.js";
import { openAnchorPeek } from "../code.js";
import type { Coverage, ClusterCoverage } from "../../coverage.js";

const SHOWN = 8;

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
  append(root, [intro(cov), clusters(cov), links(cov), sharedNames(cov), unread(cov)]);
}

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
    seg(cov.states.explained, "explained", "anchored in the document"),
    seg(cov.states.placed, "placed", "placed on the map only"),
    seg(cov.states.uncovered, "uncovered", "not examined"),
  );
}

function intro(cov: Coverage): HTMLElement {
  const key: [number, string, string][] = [
    [cov.states.explained, "explained", "anchored in the document"],
    [cov.states.placed, "placed", "placed on the map only"],
    [cov.states.uncovered, "uncovered", "not examined"],
  ];
  return h(
    "div",
    { class: "cov-intro" },
    h("h2", null, "What this explainer covers"),
    h(
      "p",
      null,
      "A codebase does not fit in a short document, so this one selects. Here is the",
      " selection, counted rather than claimed: every file in scope at the pinned commit,",
      " and which of the three states it is in.",
    ),
    bar(cov),
    h(
      "div",
      { class: "cov-key" },
      key.map(([n, cls, label]) =>
        h("span", { class: "cov-key-item" }, h("i", { class: `cov-dot ${cls}` }), `${n} ${label}`),
      ),
    ),
    h(
      "div",
      { class: "cov-facts" },
      fact("scope", cov.scope === "**" ? "the whole repository" : cov.scope),
      fact("commit", cov.commit.slice(0, 12)),
      fact("files in scope", String(cov.files.total)),
      fact("read by the code graph", `${cov.files.inGraph} of ${cov.files.total}`),
      cov.unresolved ? fact("references the graph could not place", String(cov.unresolved)) : null,
      cov.truncated
        ? fact("file list capped", "the graph is partial; treat every count as a floor")
        : null,
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

function clusterRow(c: ClusterCoverage): HTMLElement {
  const anchors = state.data?.document?.anchors ?? {};
  const firstAnchor = c.explained.length
    ? Object.values(anchors).find((a) => a.peek && c.explained.includes(a.peek.file))
    : undefined;
  return h(
    "div",
    { class: "cov-cluster" },
    h(
      "div",
      { class: "cov-cluster-head" },
      h("code", { class: "cov-label" }, c.label),
      h("span", { class: "muted" }, `${c.files} files · ${c.symbols} symbols`),
      h("span", { class: "spacer" }),
      c.explained.length
        ? h("span", { class: "badge cov-b-explained" }, `${c.explained.length} anchored`)
        : null,
      c.placed.length
        ? h("span", { class: "badge cov-b-placed" }, `${c.placed.length} placed`)
        : null,
      c.uncovered.length
        ? h("span", { class: "badge cov-b-uncovered" }, `${c.uncovered.length} not examined`)
        : null,
      firstAnchor
        ? h("button", { class: "small", onclick: () => openAnchorPeek(firstAnchor) }, "Peek code ▸")
        : null,
    ),
    c.hubs.length
      ? h(
          "div",
          { class: "muted cov-hubs" },
          "most referenced here: ",
          c.hubs.map((n) => h("code", null, n)),
        )
      : null,
    fileList(c.uncovered, "uncovered"),
  );
}

function clusters(cov: Coverage): HTMLElement {
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "By part of the system"),
    h(
      "p",
      { class: "muted" },
      "Files clustered by how they reference each other at the pinned commit, largest first.",
      " The files listed under a part are the ones this explainer never examined.",
    ),
    cov.clusters.map(clusterRow),
  );
}

function links(cov: Coverage): HTMLElement | null {
  if (!cov.links.length) return null;
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "What reaches what"),
    h(
      "p",
      { class: "muted" },
      "References that cross from one part to another, with how many there are.",
      " A pair marked both ways references each other in both directions.",
    ),
    h(
      "div",
      { class: "cov-links" },
      cov.links
        .slice(0, 24)
        .map((l) =>
          h(
            "div",
            { class: "cov-link" },
            h("code", null, label(cov, l.from)),
            h("span", { class: "muted" }, "→"),
            h("code", null, label(cov, l.to)),
            h("span", { class: "muted mono" }, `${l.references} refs`),
            l.bothWays ? h("span", { class: "badge" }, "both ways") : null,
          ),
        ),
    ),
  );
}

function label(cov: Coverage, id: string): string {
  return cov.clusters.find((c) => c.id === id)?.label ?? id;
}

function sharedNames(cov: Coverage): HTMLElement | null {
  if (!cov.sharedNames.length) return null;
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "Names defined in more than one part"),
    h(
      "p",
      { class: "muted" },
      `${cov.sharedNamesTotal} name${cov.sharedNamesTotal === 1 ? " at this commit is" : "s at this commit are"}`,
      " defined in two or more parts. What that means here - the same idea in two places,",
      " two different ideas sharing a word, or a name too common to mean anything - is",
      " what the code says and this page does not.",
    ),
    h(
      "div",
      { class: "cov-shared" },
      cov.sharedNames.map((n) =>
        h(
          "div",
          { class: "cov-link" },
          h("code", null, n.name),
          h("span", { class: "muted mono" }, `${n.clusters.length} parts`),
          h("span", { class: "muted" }, n.files.join(" · ")),
        ),
      ),
    ),
  );
}

function unread(cov: Coverage): HTMLElement | null {
  if (!cov.outsideGraph.length && !cov.files.capped && !cov.owners.length) return null;
  return h(
    "div",
    { class: "cov-section" },
    h("h3", null, "Outside the code graph"),
    cov.outsideGraph.length
      ? h(
          "div",
          null,
          h(
            "p",
            { class: "muted" },
            `${cov.files.outsideGraph} files in scope are not in a language the graph reads,`,
            " so they are in no part above. They are absent from the structure, not empty.",
          ),
          h(
            "div",
            { class: "cov-links" },
            cov.outsideGraph
              .slice(0, 16)
              .map((e) =>
                h(
                  "div",
                  { class: "cov-link" },
                  h("code", null, `.${e.extension}`),
                  h("span", { class: "muted mono" }, `${e.files} files`),
                ),
              ),
          ),
          fileList(
            cov.unclustered
              .filter((u) => u.state === "uncovered" && u.reason === "outsideGraph")
              .map((u) => u.file),
            "uncovered",
          ),
        )
      : null,
    cov.files.capped
      ? h(
          "div",
          null,
          h(
            "p",
            { class: "muted" },
            `${cov.files.capped} files in scope are in a language the graph reads, but the`,
            " repo-wide file cap was hit before this scope was read, so they were never parsed.",
          ),
          fileList(
            cov.unclustered
              .filter((u) => u.state === "uncovered" && u.reason === "capped")
              .map((u) => u.file),
            "uncovered",
          ),
        )
      : null,
    cov.owners.length
      ? h(
          "div",
          null,
          h("h4", null, "What each map node owns"),
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
        )
      : null,
  );
}
