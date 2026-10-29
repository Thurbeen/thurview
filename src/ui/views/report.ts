import { h, popover, clickPoint } from "../dom.js";
import { api } from "../api.js";
import { state, emit, navigate, canWrite, isNarrow } from "../state.js";
import { commentPopover } from "../threads.js";
import { CATEGORIES, CONFIDENCE } from "../../pr-review/categories.js";
import type { Verdict } from "../../pr-review/format.js";
import type { FileDiff } from "../../diff.js";

/**
 * The parts of the page a report reader comes for, around the document the
 * agent wrote: what the change is, the verdict and how sure it is, each finding
 * with its diff lines one step away, the risks, and what was reviewed and what
 * was not. The verdict, findings and risks exist only when the review was
 * published with its pass; without one the page opens on the summary and the
 * scope, and the document follows.
 */

type Finding = Verdict["findings"][number];
const SEVERITY_ORDER = ["blocking", "non-blocking", "nit"] as const;

export function findings(v: Verdict | null): Finding[] {
  if (!v) return [];
  return [...v.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

/** What a finding is, so a new revision cannot swap another one into its place. */
const keyOf = (f: Finding) => `${f.path}:${f.line}:${f.title}`;

const where = (f: Finding) =>
  `${f.path}:${f.startLine && f.startLine < f.line ? `${f.startLine}-` : ""}${f.line}`;

/**
 * A part of the report: its id is what the outline and the jump bar link to,
 * and its title names it to a screen reader as much as to the eye. The
 * summary's title is for the screen reader alone: the page's own title is
 * what the eye reads there.
 */
export function reportSection(
  id: string,
  title: string | null,
  note: string | null,
  ...body: (HTMLElement | null)[]
): HTMLElement {
  const label = `report-${id}-title`;
  return h(
    "section",
    {
      id: `report-${id}`,
      class: `report-section part-${id}`,
      "data-block": `report-${id}`,
      tabindex: "-1",
      ...(title ? { "aria-labelledby": label } : {}),
    },
    title
      ? h(
          "h2",
          { class: id === "summary" ? "visually-hidden" : null },
          h("span", { id: label }, title),
          note ? h("span", { class: "n" }, note) : null,
        )
      : null,
    ...body,
  );
}

/** The parts of the system the change adds to or changes, as the map names them. */
function partsMoved(): { label: string; added: boolean }[] {
  const d = state.data!;
  return (d.map?.head.nodes ?? [])
    .filter((n) => d.map?.diff.added.includes(n.id) || d.map?.diff.changed.includes(n.id))
    .map((n) => ({ label: n.label, added: !!d.map?.diff.added.includes(n.id) }));
}

/** Where the change lands, in the map's words, one step from the map itself. */
export function landsIn(): HTMLElement | null {
  const parts = partsMoved();
  if (!parts.length) return null;
  return h(
    "p",
    { class: "lands-in" },
    h("strong", null, "Lands in: "),
    parts.map((p, i) => [i ? ", " : "", p.added ? `${p.label} (new)` : p.label]).flat(),
    state.data?.map
      ? [
          " ",
          h(
            "button",
            { type: "button", class: "linklike", onclick: () => navigate("map") },
            "Open the map",
          ),
        ]
      : null,
  );
}

const FORGE_NAME: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };

/**
 * Who wrote a change request and what its forge verified of the head, as
 * sealed with the revision. These are facts about provenance, so the block
 * says so: an author who can write and a verified signature say who, not
 * whether the change is safe. What was not read is said, never left blank.
 */
export function provenanceFacts(): HTMLElement {
  const d = state.data!;
  const p = d.provenance ?? null;
  const box = h("div", { class: "provenance" });
  if (!p) {
    box.append(
      h(
        "p",
        { class: "muted" },
        d.review.binding.kind === "pr"
          ? "Author and head signature were not read for this revision: it was published before thurview recorded them, or the forge did not answer."
          : "Author and head signature not checked: this review is not bound to a pull or merge request.",
      ),
    );
    return box;
  }
  const forge = FORGE_NAME[p.forge] ?? p.forge;
  const access = {
    write: "can write to the repository",
    read: "cannot write to the repository",
    unknown: "write access could not be read",
  }[p.access];
  const signature = {
    verified: `signature verified by ${forge}`,
    unverified: `signed, but ${forge} did not verify the signature`,
    unsigned: "not signed",
    unknown: "signature not checked",
  }[p.signature];
  box.append(
    h(
      "ul",
      { class: "facts" },
      h(
        "li",
        null,
        h("strong", null, "Author: "),
        h("code", null, p.author),
        ` ${access}`,
        p.fork ? "; the change comes from a fork" : "",
        ".",
      ),
      h(
        "li",
        { class: p.signature === "verified" ? null : "warn" },
        h("strong", null, "Head: "),
        h("code", null, p.head.slice(0, 7)),
        ` ${signature}.`,
      ),
    ),
    h(
      "p",
      { class: "muted small" },
      `Read from ${forge} when the review was pinned. They say who wrote the change and from where, not whether the change is safe.`,
    ),
  );
  return box;
}

/** What the change is about and how big it is, read before the verdict. */
export function summaryFacts(): HTMLElement {
  const d = state.data!;
  const facts: (string | HTMLElement)[] = [];
  const plus = d.changes.reduce((n, c) => n + c.additions, 0);
  const minus = d.changes.reduce((n, c) => n + c.deletions, 0);
  facts.push(
    `${d.changes.length} file${d.changes.length === 1 ? "" : "s"}`,
    h(
      "span",
      { class: "diffstat" },
      h("b", { class: "a" }, `+${plus}`),
      " ",
      h("b", { class: "d" }, `−${minus}`),
    ),
  );
  const added = (d.map?.diff.added ?? [])
    .map((id) => d.map?.head.nodes.find((n) => n.id === id)?.label)
    .filter(Boolean);
  if (added.length) facts.push(`New: ${added.join(", ")}`);
  const ifd = d.document?.interfaces;
  if (ifd)
    facts.push(
      ifd.entries.length
        ? `${ifd.entries.length} interface change${ifd.entries.length === 1 ? "" : "s"}`
        : "No interface change",
    );
  return h(
    "div",
    { class: "summary-facts" },
    facts.map((f) => h("span", null, f)),
  );
}

export function verdictBlock(v: Verdict): HTMLElement {
  const d = state.data!;
  const c = Math.min(5, Math.max(1, v.confidence)) as 1 | 2 | 3 | 4 | 5;
  const list = findings(v);
  const counts = SEVERITY_ORDER.map(
    (s) => [s, list.filter((f) => f.severity === s).length] as const,
  );
  return h(
    "div",
    { class: `report-verdict c${c}` },
    h(
      "div",
      { class: "score", "aria-label": `Confidence ${c} of 5` },
      h("div", { class: "big" }, String(c), h("small", null, "/5")),
      h(
        "div",
        { class: "pips", "aria-hidden": "true" },
        [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= c ? "on" : "" })),
      ),
      h("div", { class: "lbl" }, "confidence"),
    ),
    h("div", { class: "meaning" }, CONFIDENCE[c]),
    h("div", { class: "reason" }, v.reason),
    h(
      "div",
      { class: "counts" },
      counts.map(([s, n]) =>
        h(
          "span",
          {
            class: `badge ${n && s === "blocking" ? "del" : n && s === "non-blocking" ? "warn" : ""}`,
          },
          `${n} ${s}`,
        ),
      ),
    ),
    h(
      "div",
      { class: "verdict-meta" },
      h(
        "span",
        null,
        "Reviewed ",
        h("code", null, `${d.review.pins.base.slice(0, 7)}..${v.head.slice(0, 7)}`),
      ),
      h("span", null, `Revision ${d.meta?.revision ?? d.review.revision}`),
      d.meta?.at
        ? h("span", null, `Published ${d.meta.at.replace("T", " ").slice(0, 16)} UTC`)
        : null,
    ),
  );
}

// ---- Findings, each one step from its diff lines ----

const diffs = new Map<string, Promise<FileDiff>>();
export function diffOf(path: string): Promise<FileDiff> {
  const key = `${state.id}:${state.data?.review.pins.head}:${path}`;
  let p = diffs.get(key);
  if (!p) {
    p = api.diff(state.id, path);
    diffs.set(key, p);
  }
  return p;
}

/** A window of the diff around a finding, its own lines marked. */
function diffWindow(f: Finding): HTMLElement {
  const box = h(
    "div",
    { class: "code" },
    h("div", { class: "muted loading" }, "Loading the diff…"),
  );
  const from = f.startLine && f.startLine < f.line ? f.startLine : f.line;
  diffOf(f.path).then(
    (d) => {
      const rows = d.hunks
        .flatMap((x) => x.rows)
        .filter((r) => r.newLine != null && r.newLine >= from - 3 && r.newLine <= f.line + 3);
      box.replaceChildren(
        rows.length
          ? h(
              "table",
              null,
              rows.map((r) =>
                h(
                  "tr",
                  {
                    class: [
                      r.type === "add" ? "add" : r.type === "del" ? "del" : "",
                      r.newLine! >= from && r.newLine! <= f.line ? "mark" : "",
                    ].join(" "),
                  },
                  h("td", { class: "ln" }, String(r.newLine)),
                  h("td", { class: "sg" }, r.type === "add" ? "+" : " "),
                  h("td", { html: r.html || " " }),
                ),
              ),
            )
          : h("div", { class: "muted loading" }, "These lines are outside the diff."),
      );
    },
    () => box.replaceChildren(h("div", { class: "muted loading" }, "The diff is unavailable.")),
  );
  return box;
}

/** The finding in full: the fix, its lines in the diff, a suggestion as a change. */
export function findingEvidence(f: Finding): HTMLElement {
  return h(
    "div",
    { class: "finding-evidence" },
    f.body ? h("p", { class: "fix" }, h("strong", null, "Fix: "), f.body) : null,
    h(
      "div",
      { class: "ev" },
      h(
        "div",
        { class: "ev-head" },
        h("span", { class: "t" }, "In the diff"),
        h("span", { class: "p mono" }, where(f)),
        h(
          "button",
          {
            class: "small ghost",
            onclick: () => navigate("files", { path: f.path, line: f.line, side: f.side ?? "head" }),
          },
          "Open in Files",
        ),
      ),
      diffWindow(f),
    ),
    f.suggestion
      ? h(
          "div",
          { class: "ev suggestion" },
          h("div", { class: "ev-head" }, h("span", { class: "t" }, "Suggested change")),
          h("pre", { class: "code" }, h("code", null, f.suggestion)),
        )
      : null,
    canWrite()
      ? h(
          "button",
          {
            class: "small",
            onclick: (e: MouseEvent) =>
              popover(
                commentPopover({
                  type: "file",
                  path: f.path,
                  side: f.side ?? "head",
                  line: f.line,
                }),
                clickPoint(e),
              ),
          },
          "Comment on this finding",
        )
      : null,
  );
}

/** The selected finding beside the report, on a screen wide enough for it. */
export function renderFindingSide(container: HTMLElement): void {
  const list = findings(state.data?.verdict ?? null);
  const f = list.find((x) => keyOf(x) === state.side.finding);
  if (!f) return;
  container.append(
    h(
      "div",
      { class: "side-head" },
      h(
        "div",
        { style: { flex: "1", minWidth: "0" } },
        h(
          "div",
          { class: "finding-kicker" },
          h("span", { class: `sev ${f.severity}` }, f.severity),
          " ",
          CATEGORIES[f.category].label,
        ),
        h("div", { style: { fontWeight: "600" } }, f.title),
      ),
      h(
        "button",
        {
          class: "small ghost",
          "aria-label": "Close",
          onclick: () => {
            state.side = { kind: "none" };
            emit("side");
          },
        },
        "✕",
      ),
    ),
    h("div", { class: "side-body finding-side" }, findingEvidence(f)),
  );
}

export function findingsList(v: Verdict): HTMLElement {
  const list = findings(v);
  if (!list.length)
    return h(
      "p",
      { class: "empty-part" },
      "No open findings: the review confirmed no defect to fix at this head.",
    );
  const wrap = h("div", { class: "findings" });
  const select = (i: number, el: HTMLElement, row: HTMLElement) => {
    const open = el.classList.contains("sel");
    wrap.querySelectorAll(".finding.sel").forEach((x) => {
      x.classList.remove("sel");
      x.querySelector(".finding-more")?.remove();
      x.querySelector("button.finding-row")?.setAttribute("aria-expanded", "false");
    });
    if (open) {
      if (state.side.kind === "finding") {
        state.side = { kind: "none" };
        emit("side");
      }
      return;
    }
    el.classList.add("sel");
    row.setAttribute("aria-expanded", "true");
    if (isNarrow()) el.append(h("div", { class: "finding-more" }, findingEvidence(list[i]!)));
    else {
      state.side = { kind: "finding", finding: keyOf(list[i]!) };
      emit("side");
    }
  };
  list.forEach((f, i) => {
    const el = h("div", { class: `finding sev-${f.severity}`, "data-finding": String(i) });
    const row = h(
      "button",
      { type: "button", class: "finding-row", "aria-expanded": "false" },
      h("span", { class: `sev ${f.severity}` }, f.severity),
      h(
        "span",
        { class: "finding-title" },
        f.title,
        h("span", { class: "cat" }, CATEGORIES[f.category].label),
      ),
      h("span", { class: "loc mono" }, where(f)),
    );
    row.addEventListener("click", () => select(i, el, row));
    el.append(row);
    if (state.side.kind === "finding" && state.side.finding === keyOf(f) && !isNarrow()) {
      el.classList.add("sel");
      row.setAttribute("aria-expanded", "true");
    }
    wrap.append(el);
  });
  return wrap;
}

/** J and K walk the findings, as on the forge's review pages. */
export function findingKeys(root: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !root.isConnected) return;
    if ((e.target as HTMLElement).closest?.("input,textarea,select,[contenteditable]")) return;
    if (e.key !== "j" && e.key !== "k") return;
    const rows = [...root.querySelectorAll<HTMLButtonElement>("button.finding-row")];
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.closest(".finding")?.classList.contains("sel"));
    const next =
      rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + (e.key === "j" ? 1 : -1)))]!;
    if (next.closest(".finding")?.classList.contains("sel")) return;
    e.preventDefault();
    next.click();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

// ---- Scope: what was reviewed, what was not ----

/** Added lines that no anchor in the document points at, per changed file. */
async function unexplained(): Promise<
  { path: string; added: number; lines: { line: number; html: string }[] }[]
> {
  const d = state.data!;
  const anchors = Object.values(d.document?.anchors ?? {})
    .map((a) => a.peek)
    .filter((p): p is NonNullable<typeof p> => !!p && p.graph === "head");
  const out = [];
  for (const c of d.changes) {
    if (c.status === "D" || c.binary) continue;
    const diff = await diffOf(c.path).catch(() => null);
    if (!diff) continue;
    const added = diff.hunks.flatMap((x) => x.rows).filter((r) => r.type === "add");
    const lines = added
      .filter(
        (r) =>
          !anchors.some((p) => p.file === c.path && r.newLine! >= p.from && r.newLine! <= p.to),
      )
      .map((r) => ({ line: r.newLine!, html: r.html }));
    out.push({ path: c.path, added: added.length, lines });
  }
  return out;
}

export function scopeColumns(v: Verdict | null): HTMLElement {
  const d = state.data!;
  const doc = d.document;
  const reviewed: (string | HTMLElement)[] = [];
  const gaps: (string | HTMLElement)[] = [];
  reviewed.push(
    h(
      "span",
      null,
      `The whole change, ${d.changes.length} file${d.changes.length === 1 ? "" : "s"}, at `,
      h("code", null, d.review.pins.head.slice(0, 7)),
    ),
  );
  for (const r of v?.ran ?? [])
    reviewed.push(h("span", null, `${r.what}: `, h("span", { class: "muted" }, r.result)));
  if (doc?.architecture?.state === "pending") gaps.push("Architecture: not assessed.");
  if (doc?.security?.state === "pending") gaps.push("Trust boundaries: not assessed.");
  if (v && !v.ran.some((r) => r.kind === "test")) gaps.push("No test run was recorded.");
  const unexp = h("li", { hidden: true });
  // per file, on demand: the columns above already say what was not covered
  const table = h(
    "details",
    { class: "cov", hidden: true },
    h("summary", null, "Added lines discussed, per file"),
  );
  unexplained().then((files) => {
    const n = files.reduce((a, f) => a + f.lines.length, 0);
    if (n) {
      unexp.hidden = false;
      unexp.parentElement?.querySelector(".nothing")?.remove();
      const listing = h(
        "div",
        { class: "ev unexplained-lines", hidden: true },
        files
          .filter((f) => f.lines.length)
          .map((f) =>
            h(
              "div",
              null,
              h("div", { class: "ev-head" }, h("span", { class: "p mono" }, f.path)),
              h(
                "div",
                { class: "code" },
                h(
                  "table",
                  null,
                  f.lines.map((l) =>
                    h(
                      "tr",
                      { class: "add" },
                      h("td", { class: "ln" }, String(l.line)),
                      h("td", { class: "sg" }, "+"),
                      h("td", { html: l.html || " " }),
                    ),
                  ),
                ),
              ),
            ),
          ),
      );
      const toggle = h(
        "button",
        {
          type: "button",
          class: "linklike",
          "aria-expanded": "false",
          onclick: () => {
            listing.hidden = !listing.hidden;
            toggle.setAttribute("aria-expanded", String(!listing.hidden));
          },
        },
        `${n} added line${n === 1 ? "" : "s"}`,
      );
      unexp.append(toggle, " the document does not discuss.", listing);
    }
    if (files.length) {
      table.hidden = false;
      table.append(
        h(
          "table",
          null,
          h(
            "tr",
            null,
            h("th", null, "File"),
            h("th", null, "Change"),
            h("th", null, "Added lines discussed"),
            h("th", null, "Findings"),
          ),
          files.map((f) => {
            const c = d.changes.find((x) => x.path === f.path)!;
            const said = f.added - f.lines.length;
            return h(
              "tr",
              null,
              h("td", { class: "mono f" }, f.path),
              h("td", null, `+${c.additions} −${c.deletions}`),
              h(
                "td",
                null,
                h("span", { class: "covtext" }, `${said} of ${f.added}`),
                h(
                  "span",
                  { class: "covbar", title: `${said} discussed, ${f.lines.length} not` },
                  h("i", { style: { width: `${f.added ? (said / f.added) * 100 : 100}%` } }),
                ),
              ),
              h("td", null, String((v?.findings ?? []).filter((x) => x.path === f.path).length)),
            );
          }),
        ),
      );
    }
  });
  return h(
    "div",
    null,
    h(
      "div",
      { class: "scope-cols" },
      h(
        "div",
        { class: "scope-col" },
        h("h3", null, "Reviewed"),
        h(
          "ul",
          null,
          reviewed.map((x) => h("li", null, x)),
        ),
      ),
      h(
        "div",
        { class: "scope-col gap" },
        h("h3", null, "Not covered"),
        h(
          "ul",
          null,
          gaps.map((x) => h("li", null, x)),
          gaps.length ? null : h("li", { class: "muted nothing" }, "Nothing the review recorded."),
          unexp,
        ),
      ),
    ),
    table,
  );
}
