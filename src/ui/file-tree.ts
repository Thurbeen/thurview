import { h } from "./dom.js";
import { state, isNarrow } from "./state.js";
import type { Coverage } from "../coverage.js";
import type { ChangedFile } from "../git.js";

export type TreeFile = { path: string } & Partial<Omit<ChangedFile, "path">>;
export function coverageFiles(coverage: Coverage | null | undefined): TreeFile[] {
  return (coverage?.clusters ?? [])
    .flatMap((c) => [...c.explained, ...c.placed, ...c.searched, ...c.uncovered])
    .map((path) => ({ path }));
}

interface Folder {
  path: string;
  name: string;
  children: Map<string, Folder>;
  files: TreeFile[];
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The tree remains usable without storage. */
  }
}

export function fileLayout(
  files: TreeFile[],
  content: HTMLElement,
  select: (path: string) => void,
  initial = "",
): { element: HTMLElement; setActive(path: string): void } {
  const folder: Folder = { path: "", name: "", children: new Map(), files: [] };
  for (const file of [...new Map(files.map((f) => [f.path, f])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const parts = file.path.split("/");
    let parent = folder;
    for (const name of parts.slice(0, -1)) {
      let child = parent.children.get(name);
      if (!child) {
        child = {
          path: parent.path ? `${parent.path}/${name}` : name,
          name,
          children: new Map(),
          files: [],
        };
        parent.children.set(name, child);
      }
      parent = child;
    }
    parent.files.push(file);
  }
  const foldKey = `thurview.tree.folds.${state.id}`;
  let folds: Set<string>;
  try {
    const stored: unknown = JSON.parse(read(foldKey) ?? "[]");
    folds = new Set(
      Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    folds = new Set();
  }
  let active = initial;
  let focusPath = initial;
  let query = "";
  let filteredFolds = new Set<string>();
  const closed = (path: string) => (query ? filteredFolds : folds).has(path);
  const tree = h("div", { class: "file-tree", role: "tree", "aria-label": "Files" });
  const list = h("aside", { class: "file-list", "aria-label": "File explorer" });
  const widthKey = "thurview.tree.width";
  const width = Number(read(widthKey));
  const layout = h("div", { class: "files-layout" });
  layout.style.setProperty("--tree-width", `${Math.max(220, Math.min(600, width || 340))}px`);
  let collapsed = isNarrow() || read("thurview.tree.hidden") === "1";
  const show = h(
    "button",
    { class: "small tree-show", "aria-label": "Show file tree", onclick: () => toggle(false) },
    "Files ▸",
  );
  const hide = h(
    "button",
    { class: "small ghost", "aria-label": "Hide file tree", onclick: () => toggle(true) },
    "◂",
  );
  const toggle = (hidden: boolean) => {
    collapsed = hidden;
    layout.classList.toggle("tree-hidden", hidden);
    show.setAttribute("aria-expanded", String(!hidden));
    if (!isNarrow()) save("thurview.tree.hidden", hidden ? "1" : "0");
    if (hidden) show.focus();
    else filter.focus();
  };
  const filter = h("input", {
    type: "search",
    placeholder: "Filter files…",
    "aria-label": "Filter files",
    oninput: () => {
      query = filter.value.trim().toLocaleLowerCase();
      filteredFolds.clear();
      render();
    },
  });
  const allFolders = (f: Folder): string[] =>
    [...f.children.values()].flatMap((c) => [c.path, ...allFolders(c)]);
  const persist = () => save(foldKey, JSON.stringify([...folds]));
  const foldAll = (close: boolean) => {
    if (query) filteredFolds = new Set(close ? allFolders(folder) : []);
    else {
      folds = new Set(close ? allFolders(folder) : []);
      persist();
    }
    render();
  };
  list.append(
    h(
      "div",
      { class: "tree-toolbar" },
      h("strong", null, "Files"),
      h(
        "button",
        { class: "small ghost", "aria-label": "Expand all folders", onclick: () => foldAll(false) },
        "Expand all",
      ),
      h(
        "button",
        {
          class: "small ghost",
          "aria-label": "Collapse all folders",
          onclick: () => foldAll(true),
        },
        "Collapse all",
      ),
      hide,
    ),
    filter,
    tree,
  );
  list.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isNarrow()) toggle(true);
  });
  const separator = h("div", {
    class: "tree-resizer",
    role: "separator",
    tabindex: 0,
    "aria-label": "Resize file tree",
    "aria-orientation": "vertical",
    "aria-valuemin": 220,
    "aria-valuemax": 600,
  });
  const resize = (value: number) => {
    const next = Math.max(220, Math.min(600, value));
    layout.style.setProperty("--tree-width", `${next}px`);
    separator.setAttribute("aria-valuenow", String(next));
    save(widthKey, String(next));
  };
  separator.setAttribute("aria-valuenow", String(Math.max(220, Math.min(600, width || 340))));
  separator.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    separator.setPointerCapture(e.pointerId);
  });
  separator.addEventListener("pointermove", (e) => {
    if (separator.hasPointerCapture(e.pointerId))
      resize(e.clientX - layout.getBoundingClientRect().left);
  });
  separator.addEventListener("pointerup", (e) => {
    if (separator.hasPointerCapture(e.pointerId)) separator.releasePointerCapture(e.pointerId);
  });
  separator.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      resize(Number(separator.getAttribute("aria-valuenow")) + (e.key === "ArrowLeft" ? -20 : 20));
    }
  });
  layout.append(show, list, separator, content);
  layout.classList.toggle("tree-hidden", collapsed);
  show.setAttribute("aria-expanded", String(!collapsed));

  const descendants = (f: Folder): TreeFile[] => [
    ...f.files,
    ...[...f.children.values()].flatMap(descendants),
  ];
  const matches = (f: TreeFile) =>
    !query || `${f.path} ${f.oldPath ?? ""}`.toLocaleLowerCase().includes(query);
  const visibleRows = (): HTMLElement[] =>
    [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
      (e) => !e.closest("[hidden]"),
    );
  const markFocus = (row: HTMLElement) => {
    for (const item of tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      item.tabIndex = item === row ? 0 : -1;
    focusPath = row.dataset.file ?? row.dataset.folder ?? "";
  };
  const focus = (row: HTMLElement | undefined) => {
    if (row) {
      markFocus(row);
      row.focus();
    }
  };
  const stats = (entries: TreeFile[]) => {
    const changed = entries.filter((f) => f.status);
    return changed.length
      ? h(
          "span",
          { class: "stat" },
          h("span", { class: "a" }, `+${changed.reduce((n, f) => n + (f.additions ?? 0), 0)}`),
          " ",
          h("span", { class: "d" }, `−${changed.reduce((n, f) => n + (f.deletions ?? 0), 0)}`),
        )
      : null;
  };
  const markers = (entries: TreeFile[]) => {
    const paths = new Set(entries.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
    const anchored = Object.values(state.data?.document?.anchors ?? {}).some(
      (a) => a.peek && paths.has(a.peek.file),
    );
    const comments = (state.data?.threads ?? []).filter(
      (t) => t.target.type === "file" && paths.has(t.target.path),
    );
    const open = comments.filter((t) => t.status === "open").length;
    return [
      anchored
        ? h(
            "span",
            {
              class: "tree-marker",
              title: "Anchored in the document",
              "aria-label": "Anchored in the document",
            },
            "◆",
          )
        : null,
      comments.length
        ? h(
            "span",
            {
              class: `badge ${open ? "accent" : ""}`,
              title: `${comments.length} comment${comments.length === 1 ? "" : "s"}, ${open} open thread${open === 1 ? "" : "s"}`,
              "aria-label": `${comments.length} comments, ${open} open threads`,
            },
            `●${comments.length}`,
          )
        : null,
    ];
  };
  const activate = (path: string) => {
    setActive(path);
    select(path);
    if (isNarrow()) toggle(true);
  };
  const row = (
    path: string,
    name: string,
    depth: number,
    entries: TreeFile[],
    directory: boolean,
    parent: HTMLElement | null,
  ): HTMLElement => {
    const file = entries[0]!;
    const item = h("div", {
      role: "treeitem",
      tabindex: -1,
      "aria-level": depth,
      ...(directory
        ? { "data-folder": path, "aria-expanded": String(!closed(path)) }
        : { "data-file": path, "aria-selected": String(path === active) }),
    });
    const label = h("span", { class: "name" }, name);
    const statusNames = {
      A: "Added",
      M: "Modified",
      D: "Deleted",
      R: "Renamed",
      C: "Copied",
      T: "Type changed",
    };
    const header = h(
      "div",
      {
        class: `tree-row ${!directory && path === active ? "active" : ""}`,
        style: { paddingLeft: `${8 + (depth - 1) * 14}px` },
        title: directory ? path : `${path}${file.oldPath ? ` ← ${file.oldPath}` : ""}`,
      },
      h(
        "span",
        { class: "tree-icon", "aria-hidden": "true" },
        directory ? (closed(path) ? "▸" : "▾") : "·",
      ),
      label,
      !directory && file.status
        ? h(
            "span",
            {
              class: `badge ${file.status === "A" ? "ok" : file.status === "D" ? "del" : ""}`,
              title: statusNames[file.status],
              "aria-label": statusNames[file.status],
            },
            file.status,
          )
        : null,
      markers(entries),
      stats(entries),
    );
    if (!directory && file.oldPath)
      label.appendChild(h("small", { class: "tree-origin" }, `← ${file.oldPath}`));
    item.setAttribute("aria-label", header.textContent ?? name);
    item.appendChild(header);
    const fold = (close: boolean) => {
      const target = query ? filteredFolds : folds;
      if (close) target.add(path);
      else target.delete(path);
      if (!query) persist();
      focusPath = path;
      render();
      focus(visibleRows().find((e) => e.dataset.folder === path));
    };
    item.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest('[role="treeitem"]') !== item) return;
      focus(item);
      if (directory) fold(item.getAttribute("aria-expanded") === "true");
      else activate(path);
    });
    item.addEventListener("focus", () => markFocus(item));
    item.addEventListener("keydown", (e) => {
      if (e.target !== item) return;
      const rows = visibleRows();
      const index = rows.indexOf(item);
      if (
        !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(
          e.key,
        )
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowDown") focus(rows[index + 1]);
      else if (e.key === "ArrowUp") focus(rows[index - 1]);
      else if (e.key === "Home") focus(rows[0]);
      else if (e.key === "End") focus(rows.at(-1));
      else if (e.key === "ArrowLeft") {
        if (directory && item.getAttribute("aria-expanded") === "true") fold(true);
        else focus(parent ?? undefined);
      } else if (e.key === "ArrowRight") {
        if (directory && item.getAttribute("aria-expanded") === "false") fold(false);
        else if (directory) focus(rows[index + 1]);
      } else if (directory) fold(item.getAttribute("aria-expanded") === "true");
      else activate(path);
    });
    return item;
  };
  const renderFolder = (
    f: Folder,
    group: HTMLElement,
    depth: number,
    parent: HTMLElement | null,
  ) => {
    for (let child of f.children.values()) {
      if (!descendants(child).some(matches)) continue;
      let name = child.name;
      while (!child.files.length && child.children.size === 1) {
        child = [...child.children.values()][0]!;
        name += `/${child.name}`;
      }
      const entries = descendants(child).filter(matches);
      const item = row(child.path, name, depth, entries, true, parent);
      const children = h("div", { role: "group" });
      children.hidden = closed(child.path);
      renderFolder(child, children, depth + 1, item);
      item.appendChild(children);
      group.appendChild(item);
    }
    for (const file of f.files.filter(matches))
      group.appendChild(row(file.path, file.path.split("/").at(-1)!, depth, [file], false, parent));
  };
  const render = () => {
    tree.replaceChildren();
    renderFolder(folder, tree, 1, null);
    const rows = visibleRows();
    const selected =
      rows.find((e) => (e.dataset.file ?? e.dataset.folder) === focusPath) ??
      rows.find((e) => e.dataset.file === active) ??
      rows[0];
    if (selected) markFocus(selected);
    else
      tree.appendChild(
        h(
          "div",
          { class: "empty-state", role: "status" },
          files.length ? "No matching files." : "No files to show.",
        ),
      );
  };
  const setActive = (path: string) => {
    active = path;
    for (const item of tree.querySelectorAll<HTMLElement>("[data-file]")) {
      const selected = item.dataset.file === path;
      item.setAttribute("aria-selected", String(selected));
      item.firstElementChild?.classList.toggle("active", selected);
    }
  };
  render();
  return { element: layout, setActive };
}
