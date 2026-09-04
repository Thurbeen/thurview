import { api } from "../api.js";
import { h } from "../dom.js";
import { state, navigate } from "../state.js";

export async function renderCommits(root: HTMLElement): Promise<void> {
  const el = h("div", { class: "commits" }, h("div", { class: "muted" }, "Loading…"));
  root.appendChild(el);
  const commits = await api.commits(state.id);
  el.innerHTML = "";
  const r = state.data!.review;
  el.appendChild(
    h(
      "p",
      { class: "muted" },
      `${commits.length} commit${commits.length === 1 ? "" : "s"} from `,
      h("code", null, r.pins.base.slice(0, 12)),
      " to ",
      h("code", null, r.pins.head.slice(0, 12)),
    ),
  );
  if (!commits.length)
    el.appendChild(h("div", { class: "empty-state" }, "No commits between base and head."));
  for (const c of commits) {
    el.appendChild(
      h(
        "div",
        { class: "commit" },
        h(
          "div",
          null,
          h("span", { class: "subject" }, c.subject),
          " ",
          h("code", null, c.shortSha),
          " ",
          h("span", { class: "muted" }, `${c.author} · ${new Date(c.date).toLocaleString()}`),
        ),
        c.body ? h("pre", null, c.body) : null,
        h(
          "div",
          { class: "files" },
          c.files.map((f) => h("span", { onclick: () => navigate("files", { path: f }) }, f)),
        ),
      ),
    );
  }
}
