import { api } from "./api.js";
import { h, closePopover, dialog, timeAgo } from "./dom.js";
import { state, emit, describeTarget, navigate, readOnly } from "./state.js";
import type { Thread, ThreadTarget } from "../store.js";

export async function reload(): Promise<void> {
  state.data = await api.review(state.id, state.viewingRevision ?? undefined);
  emit("threads");
}

/** Popover to start a thread on a target. */
export function commentPopover(target: ThreadTarget, quote?: string): HTMLElement {
  const ta = h("textarea", { placeholder: "Comment, or a question for the agent…" });
  let mode: "review" | "ask" = "review";
  const modeBtns = h("div", { class: "row" });
  const b1 = h("button", { class: "small primary", onclick: () => set("review") }, "Add to review");
  const b2 = h("button", { class: "small", onclick: () => set("ask") }, "Ask now");
  const set = (m: "review" | "ask") => {
    mode = m;
    b1.className = `small ${m === "review" ? "primary" : ""}`;
    b2.className = `small ${m === "ask" ? "primary" : ""}`;
    hint.textContent =
      m === "review"
        ? "Held until you submit the review."
        : "Sent to the agent at once; it answers in this thread.";
  };
  const hint = h(
    "span",
    { class: "muted", style: { fontSize: "12px" } },
    "Held until you submit the review.",
  );
  modeBtns.append(b1, b2, hint);
  const submit = async () => {
    const body = ta.value.trim();
    if (!body) return;
    await api.createThread(state.id, {
      kind: mode === "ask" ? "question" : "comment",
      mode,
      target: quote ? ({ ...target, quote } as ThreadTarget) : target,
      body,
    });
    closePopover();
    await reload();
  };
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
  });
  const el = h(
    "div",
    { class: "comment-popover" },
    quote ? h("div", { class: "quote" }, quote) : null,
    h(
      "div",
      { class: "muted", style: { fontSize: "12px", marginBottom: "4px" } },
      describeTarget(target),
    ),
    ta,
    modeBtns,
    h(
      "div",
      { class: "row", style: { justifyContent: "flex-end" } },
      h("button", { class: "small ghost", onclick: () => closePopover() }, "Cancel"),
      h("button", { class: "small ok", onclick: submit }, "Save ", h("kbd", null, "⌘↵")),
    ),
  );
  setTimeout(() => ta.focus());
  return el;
}

/** Compact pin shown next to a document block or diff line. */
export function threadPinRow(t: Thread): HTMLElement {
  const first = t.messages[0];
  const last = t.messages[t.messages.length - 1];
  return h(
    "div",
    {
      class: `thread-pin ${t.status === "resolved" ? "resolved" : ""}`,
      onclick: () => focusThread(t.id),
    },
    h(
      "span",
      { class: `badge ${t.kind === "question" ? "accent" : ""}` },
      t.kind === "question" ? "Q" : t.submitted ? "C" : "draft",
    ),
    h("span", { class: "who" }, first?.role === "agent" ? "agent" : "you"),
    h(
      "span",
      {
        style: {
          flex: "1",
          minWidth: "0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      },
      first?.body ?? "",
    ),
    t.messages.length > 1
      ? h(
          "span",
          { class: "muted" },
          `${t.messages.length - 1} repl${t.messages.length > 2 ? "ies" : "y"} · ${last?.role}`,
        )
      : null,
    t.status === "resolved" ? h("span", { class: "badge ok" }, "resolved") : null,
  );
}

export function focusThread(id: string): void {
  state.side = { kind: "threads", activeThread: id };
  emit("side");
}

function goToTarget(t: Thread): void {
  const tg = t.target;
  if (tg.type === "document") {
    navigate("review", { block: tg.blockId });
  } else if (tg.type === "file") {
    navigate("files", { path: tg.path, line: tg.line, side: tg.side });
  } else if (tg.type === "map") {
    navigate("map", { node: tg.node });
  }
}

export function renderThreadsPanel(container: HTMLElement): void {
  const threads = state.data?.threads ?? [];
  const pending = threads.filter((t) => !t.submitted);
  let showResolved = false;
  const head = h(
    "div",
    { class: "side-head" },
    h(
      "div",
      { style: { flex: "1" } },
      h("b", null, "Threads"),
      " ",
      h("span", { class: "muted" }, `${threads.filter((t) => t.status === "open").length} open`),
    ),
    h(
      "label",
      { style: { fontSize: "12px" } },
      h("input", {
        type: "checkbox",
        onchange: (e: Event) => {
          showResolved = (e.target as HTMLInputElement).checked;
          draw();
        },
      }),
      " resolved",
    ),
    h(
      "button",
      {
        class: "small ghost",
        onclick: () => {
          state.side = { kind: "none" };
          emit("side");
        },
      },
      "✕",
    ),
  );
  const body = h("div", { class: "side-body" });
  const draw = () => {
    body.innerHTML = "";
    if (pending.length && !readOnly()) {
      body.appendChild(
        h(
          "div",
          { class: "banner" },
          `${pending.length} comment${pending.length > 1 ? "s" : ""} pending`,
          h("span", { style: { flex: "1" } }),
          h("button", { class: "small primary", onclick: () => submitDialog() }, "Submit review"),
        ),
      );
    }
    const list = h("div", { class: "threads" });
    const shown = threads.filter(
      (t) => showResolved || t.status === "open" || t.id === state.side.activeThread,
    );
    if (!shown.length)
      list.appendChild(
        h(
          "div",
          { class: "empty-state" },
          "No threads yet. Select text, click a line number, or use the + next to a paragraph.",
        ),
      );
    for (const t of shown.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
      list.appendChild(threadCard(t));
    body.appendChild(list);
  };
  draw();
  container.append(head, body);
  if (state.side.activeThread)
    setTimeout(() => body.querySelector(".thread.active")?.scrollIntoView({ block: "center" }));
}

function threadCard(t: Thread): HTMLElement {
  const ta = h("textarea", { placeholder: "Reply…", rows: 2 });
  const send = async () => {
    const v = ta.value.trim();
    if (!v) return;
    await api.reply(state.id, t.id, v);
    await reload();
  };
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
  });
  const quote =
    t.target.type === "document" || t.target.type === "file" ? t.target.quote : undefined;
  return h(
    "div",
    { class: `thread ${state.side.activeThread === t.id ? "active" : ""}` },
    h(
      "div",
      { class: "thead" },
      h(
        "span",
        { class: `badge ${t.kind === "question" ? "accent" : ""}` },
        t.kind === "question" ? "question" : t.submitted ? "comment" : "pending",
      ),
      h("span", { class: "target", onclick: () => goToTarget(t) }, describeTarget(t.target)),
      h("span", { class: `badge ${t.status === "resolved" ? "ok" : ""}` }, t.status),
    ),
    quote
      ? h("div", { class: "quote" }, `“${quote.length > 160 ? quote.slice(0, 160) + "…" : quote}”`)
      : null,
    t.messages.map((m) =>
      h(
        "div",
        { class: `msg ${m.role}` },
        h("span", { class: "who" }, m.role === "agent" ? "Agent" : "You"),
        h("span", { class: "muted", style: { fontSize: "11px" } }, timeAgo(m.at)),
        h("div", null, m.body),
      ),
    ),
    readOnly()
      ? null
      : h(
          "div",
          { class: "reply" },
          ta,
          h(
            "div",
            { class: "row" },
            !t.submitted
              ? h(
                  "button",
                  {
                    class: "small ghost",
                    onclick: async () => {
                      await api.deleteThread(state.id, t.id);
                      await reload();
                    },
                  },
                  "Delete",
                )
              : null,
            t.status === "open"
              ? h(
                  "button",
                  {
                    class: "small",
                    onclick: async () => {
                      await api.resolve(state.id, t.id);
                      await reload();
                    },
                  },
                  "Resolve",
                )
              : h(
                  "button",
                  {
                    class: "small",
                    onclick: async () => {
                      await api.reopen(state.id, t.id);
                      await reload();
                    },
                  },
                  "Reopen",
                ),
            h("button", { class: "small primary", onclick: send }, "Reply"),
          ),
        ),
  );
}

export function submitDialog(): void {
  const pending = (state.data?.threads ?? []).filter((t) => !t.submitted).length;
  const ta = h("textarea", { rows: 4, placeholder: "Summary for the agent (optional)" });
  const d = dialog(
    h(
      "div",
      null,
      h("h3", null, "Submit review"),
      h(
        "p",
        { class: "muted" },
        pending
          ? `${pending} pending comment${pending > 1 ? "s" : ""} will be sent to the agent.`
          : "No pending comments.",
      ),
      ta,
      h(
        "div",
        { class: "row" },
        h("button", { class: "ghost", onclick: () => d.close() }, "Cancel"),
        h(
          "button",
          { title: "End the review without approving it", onclick: () => decide("close") },
          "Close",
        ),
        h("button", { onclick: () => decide("request-changes") }, "Request changes"),
        h("button", { class: "ok", onclick: () => decide("approve") }, "Approve"),
      ),
    ),
  );
  const decide = async (decision: "approve" | "request-changes" | "close") => {
    await api.submit(state.id, decision, ta.value.trim());
    d.close();
    await reload();
    emit("data");
  };
}
