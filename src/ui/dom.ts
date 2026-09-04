type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "html") el.innerHTML = String(v);
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k in el && typeof v !== "string" && k !== "title")
        (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else
      el.appendChild(
        typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c,
      );
  }
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

/** One popover at a time; closes on outside click or Escape. */
let openPopover: HTMLElement | null = null;
export function popover(el: HTMLElement, at: { x: number; y: number }): HTMLElement {
  closePopover();
  el.style.position = "absolute";
  document.body.appendChild(el);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const x = Math.min(at.x, window.innerWidth - w - 12);
  const y = at.y + hgt > window.scrollY + window.innerHeight - 12 ? at.y - hgt - 8 : at.y;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
  openPopover = el;
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
  });
  return el;
}
function onDoc(e: MouseEvent) {
  if (openPopover && !openPopover.contains(e.target as Node)) closePopover();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closePopover();
}
export function closePopover(): void {
  if (openPopover) openPopover.remove();
  openPopover = null;
  document.removeEventListener("mousedown", onDoc);
  document.removeEventListener("keydown", onKey);
}

export function dialog(content: HTMLElement): { close: () => void } {
  const overlay = h("div", { class: "overlay" }, h("div", { class: "dialog" }, content));
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  return { close: () => overlay.remove() };
}
