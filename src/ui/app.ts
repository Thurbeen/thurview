import { api } from "./api.js";
import { h, append, clear, dialog, timeAgo } from "./dom.js";
import { state, on, emit, readHash, navigate, isTerminal, NARROW, type View } from "./state.js";
import { renderPeek } from "./code.js";
import { renderThreadsPanel, submitDialog, reload } from "./threads.js";
import { renderReview } from "./views/review.js";
import { renderFiles } from "./views/files.js";
import { renderCommits } from "./views/commits.js";
import { renderMap } from "./views/map.js";

const app = document.getElementById("app")!;

async function home(): Promise<void> {
  clear(app);
  const reviews = await api.reviews();
  const el = h("div", { class: "home" }, h("h2", null, "Reviews"));
  const active = reviews.filter((r) => !r.dismissed);
  const dismissed = reviews.filter((r) => r.dismissed);
  const item = (r: (typeof reviews)[number]) =>
    h(
      "div",
      { class: "item", onclick: () => (location.href = `/review/${r.id}`) },
      h("span", { class: "t" }, r.title),
      h("span", { class: `badge ${statusClass(r.status)}` }, r.status),
      r.openThreads ? h("span", { class: "badge accent" }, `${r.openThreads} open`) : null,
      h(
        "span",
        { class: "muted mono", style: { fontSize: "12px" } },
        r.binding.kind === "pr" ? `PR #${r.binding.name}` : r.binding.name,
      ),
      h("span", { class: "muted", style: { fontSize: "12px" } }, timeAgo(r.updatedAt)),
    );
  if (!active.length)
    el.appendChild(
      h("div", { class: "empty-state" }, "No reviews. Ask your agent to scaffold and publish one."),
    );
  active.forEach((r) => el.appendChild(item(r)));
  if (dismissed.length) {
    el.appendChild(h("h3", { class: "muted" }, "Dismissed"));
    dismissed.forEach((r) => el.appendChild(item(r)));
  }
  app.appendChild(el);
}

function statusClass(s: string): string {
  return s === "accepted"
    ? "ok"
    : s === "awaiting-agent-updates"
      ? "warn"
      : s === "closed"
        ? "del"
        : s === "awaiting-review"
          ? "accent"
          : "";
}

let center: HTMLElement;
let side: HTMLElement;
let topbar: HTMLElement;
let banner: HTMLElement;

function shell(): void {
  clear(app);
  topbar = h("div", { class: "topbar" });
  banner = h("div", { class: "banner", hidden: true });
  center = h("div", { class: "center" });
  side = h("div", { class: "side hidden" });
  const resizer = h("div", { class: "resizer" });
  let drag = false;
  resizer.addEventListener("mousedown", () => (drag = true));
  window.addEventListener("mouseup", () => (drag = false));
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const w = Math.max(320, window.innerWidth - e.clientX);
    document.documentElement.style.setProperty("--side-w", `${w}px`);
  });
  app.append(topbar, banner, h("div", { class: "main" }, center, resizer, side));
}

function applyTheme(): void {
  let style = document.getElementById("review-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "review-theme";
    document.head.appendChild(style);
  }
  style.textContent = state.data?.theme?.css ?? "";
}

function renderTopbar(): void {
  clear(topbar);
  const d = state.data!;
  const r = d.review;
  const pending = d.threads.filter((t) => !t.submitted).length;
  const open = d.threads.filter((t) => t.status === "open").length;
  const tabs: [View, string][] = [
    ["review", "Review"],
    ["commits", "Commits"],
    ["files", `Files${d.changes.length ? ` (${d.changes.length})` : ""}`],
    ["map", "Map"],
  ];
  const revSel = h("select", {
    class: "small",
    style: { font: "inherit", fontSize: "12px" },
    onchange: async (e: Event) => {
      const n = Number((e.target as HTMLSelectElement).value);
      state.viewingRevision = n === r.revision ? null : n;
      state.data = await api.review(state.id, n);
      emit("data");
    },
  });
  for (let n = r.revision; n >= 1; n--)
    revSel.appendChild(
      h(
        "option",
        { value: n, selected: (state.viewingRevision ?? r.revision) === n },
        `rev ${n}${n === r.revision ? " (current)" : ""}`,
      ),
    );
  // Two rows, so a long title can never push the tabs or the decision button
  // off the bar: the identity row truncates, the actions row does not.
  const identity = h("div", { class: "bar-row bar-identity" }, [
    h("a", { href: "/", class: "brand", title: "All reviews" }, "thurview"),
    h("span", { class: "title", title: r.title }, r.title),
    h("span", { class: `badge ${statusClass(r.status)}` }, r.status),
    r.revision > 1 ? revSel : h("span", { class: "badge bar-rev" }, `rev ${r.revision}`),
    h(
      "span",
      {
        class: "muted mono bar-binding",
        style: { fontSize: "12px" },
        title: `${r.pins.base} → ${r.pins.head}`,
      },
      r.binding.kind === "pr" ? `PR #${r.binding.name}` : r.binding.name,
    ),
  ]);
  const actions = h("div", { class: "bar-row bar-actions" }, [
    h(
      "div",
      { class: "tabs" },
      tabs.map(([v, label]) =>
        h("button", { class: v === state.view ? "active" : "", onclick: () => navigate(v) }, label),
      ),
    ),
    h("span", { class: "spacer" }),
    h(
      "button",
      {
        class: state.side.kind === "threads" ? "primary" : "",
        onclick: () => {
          state.side = state.side.kind === "threads" ? { kind: "none" } : { kind: "threads" };
          emit("side");
        },
      },
      `Threads${open ? ` · ${open}` : ""}`,
    ),
    isTerminal() || state.viewingRevision !== null
      ? null
      : h(
          "button",
          { class: pending ? "primary" : "ok", onclick: () => submitDialog() },
          pending ? `Submit${pending ? ` (${pending})` : ""}` : "Decide",
        ),
    h(
      "button",
      { class: "ghost bar-more", title: "More", onclick: (e: MouseEvent) => moreMenu(e) },
      "⋯",
    ),
  ]);
  append(topbar, [identity, actions]);
}

function moreMenu(e: MouseEvent): void {
  const r = state.data!.review;
  const box = h(
    "div",
    { class: "def-popover" },
    h(
      "div",
      {
        class: "item",
        onclick: async () => {
          await api.dismiss(state.id, !r.dismissed);
          await reload();
          emit("data");
        },
      },
      r.dismissed ? "Restore review" : "Dismiss review",
    ),
    h(
      "div",
      {
        class: "item",
        onclick: () => {
          const d = dialog(
            h(
              "div",
              null,
              h("h3", null, "Delete this review?"),
              h(
                "p",
                { class: "muted" },
                "Removes the document, revisions and threads. The code is untouched.",
              ),
              h(
                "div",
                { class: "row" },
                h("button", { class: "ghost", onclick: () => d.close() }, "Cancel"),
                h(
                  "button",
                  {
                    style: { background: "var(--del)", color: "#fff" },
                    onclick: async () => {
                      await api.remove(state.id);
                      location.href = "/";
                    },
                  },
                  "Delete",
                ),
              ),
            ),
          );
        },
      },
      "Delete review",
    ),
    h(
      "div",
      { class: "item muted" },
      `base ${r.pins.base.slice(0, 12)} · head ${r.pins.head.slice(0, 12)}`,
    ),
    h(
      "div",
      { class: "item muted" },
      `theme: ${state.data!.theme?.name ?? "default"}${state.data!.theme?.source ? ` (${state.data!.theme.source})` : ""}`,
    ),
  );
  import("./dom.js").then(({ popover }) => popover(box, { x: e.pageX - 200, y: e.pageY + 10 }));
}

function renderCenter(): void {
  const scroll = center.scrollTop;
  clear(center);
  switch (state.view) {
    case "review":
      renderReview(center);
      break;
    case "files":
      renderFiles(center);
      break;
    case "commits":
      void renderCommits(center);
      break;
    case "map":
      renderMap(center);
      break;
  }
  center.scrollTop = scroll;
}

function renderSide(): void {
  clear(side);
  side.classList.toggle("hidden", state.side.kind === "none");
  if (state.side.kind === "peek") renderPeek(side);
  else if (state.side.kind === "threads") renderThreadsPanel(side);
}

function renderBanner(): void {
  banner.hidden = true;
  clear(banner);
  const d = state.data!;
  if (state.viewingRevision !== null) {
    banner.hidden = false;
    banner.append(
      `Viewing revision ${state.viewingRevision} of ${d.review.revision}. Read only.`,
      h("span", { style: { flex: "1" } }),
      h(
        "button",
        {
          class: "small",
          onclick: async () => {
            state.viewingRevision = null;
            state.data = await api.review(state.id);
            emit("data");
          },
        },
        "Back to current",
      ),
    );
  } else if (state.latestRevision !== null && state.latestRevision > d.review.revision) {
    banner.hidden = false;
    banner.append(
      `Revision ${state.latestRevision} was published.`,
      h("span", { style: { flex: "1" } }),
      h(
        "button",
        {
          class: "small primary",
          onclick: async () => {
            state.latestRevision = null;
            state.data = await api.review(state.id);
            emit("data");
          },
        },
        "Load it",
      ),
    );
  } else if (d.review.status === "awaiting-agent-updates") {
    banner.hidden = false;
    banner.append(
      "Changes requested. The agent is working on your comments; a new revision will appear here.",
    );
  } else if (d.review.status === "accepted") {
    banner.hidden = false;
    banner.append("Approved. This review is complete.");
  } else if (d.review.status === "closed") {
    banner.hidden = false;
    banner.append("Closed without approval. This review is complete.");
  }
}

function connectEvents(): void {
  const es = new EventSource(`/api/reviews/${state.id}/events`);
  es.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data as string) as { type: string };
    if (msg.type !== "change") return;
    const fresh = await api.review(state.id, state.viewingRevision ?? undefined);
    const cur = state.data!;
    if (fresh.review.revision > cur.review.revision && state.viewingRevision === null) {
      state.latestRevision = fresh.review.revision;
      // keep the presented document until the reader loads it, but take threads and status
      state.data = {
        ...cur,
        threads: fresh.threads,
        decisions: fresh.decisions,
        review: { ...fresh.review, revision: cur.review.revision },
      };
    } else {
      state.data = fresh;
    }
    emit("threads");
  };
}

async function reviewPage(id: string): Promise<void> {
  state.id = id;
  shell();
  readHash();
  try {
    state.data = await api.review(id);
  } catch (e) {
    clear(app);
    app.appendChild(
      h(
        "div",
        { class: "empty-state" },
        (e as Error).message,
        " ",
        h("a", { href: "/" }, "All reviews"),
      ),
    );
    return;
  }
  document.title = `${state.data.review.title} · thurview`;
  if (state.params.get("side") === "threads") state.side = { kind: "threads" };
  on("data", () => {
    applyTheme();
    renderTopbar();
    renderBanner();
    renderCenter();
    renderSide();
  });
  on("threads", () => {
    renderTopbar();
    renderBanner();
    renderCenter();
    renderSide();
  });
  on("view", () => {
    renderTopbar();
    renderCenter();
  });
  on("side", () => {
    renderTopbar();
    renderSide();
  });
  window.addEventListener("hashchange", () => {
    readHash();
    emit("view");
  });
  window.matchMedia(NARROW).addEventListener("change", () => emit("view"));
  emit("data");
  connectEvents();
}

const m = /^\/review\/([^/]+)/.exec(location.pathname);
if (m) void reviewPage(m[1]!);
else void home();
