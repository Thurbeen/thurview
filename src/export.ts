import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Coverage } from "./coverage.js";
import { log, showFile } from "./git.js";
import { readThreads, type ReviewState } from "./store.js";
import { NOBODY } from "./presence.js";
import { revisionData, fileDiff, fileLines } from "./server/server.js";
import { exportMarkdown } from "./export-markdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = existsSync(join(HERE, "ui", "app.js"))
  ? join(HERE, "ui")
  : resolve(HERE, "..", "dist", "ui");

/**
 * Where an exported page goes. One local path today: a file, or a folder that
 * receives `index.html`. A git repository's Pages folder or a synced static
 * host directory is that same local path; pushing it on is the owner's step.
 */
export interface ExportTarget {
  write(html: string): Promise<string>;
}

export function localTarget(out: string): ExportTarget {
  return {
    async write(html) {
      const file = /\.html?$/i.test(out) ? resolve(out) : resolve(out, "index.html");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, html);
      return file;
    },
  };
}

/**
 * Everything the browser app would ask the server for, answered ahead of time
 * at the review's pins: the document as published, the commits, every changed
 * file's diff, and the whole of every file a diff or an anchor shows, so that
 * expanding context still works with no server. Symbol lookup is left out.
 */
async function snapshot(review: ReviewState, withThreads: boolean) {
  const data = await revisionData(review, review.revision);
  const t = await readThreads(review.id);
  const isReview = (review.kind ?? "review") === "review";
  const changes = isReview ? data.changes : [];
  const diffs: Record<string, unknown> = {};
  const files: Record<string, unknown> = {};
  const want = new Set<string>();
  // Drafts the reader never sent stay theirs; only what was said is shown.
  const threads = withThreads ? t.threads.filter((x) => x.submitted || x.mode === "ask") : [];
  const commits = isReview ? await log(review.worktree, review.pins.base, review.pins.head) : [];
  for (const c of changes) {
    const d = await fileDiff(review, c.path);
    diffs[c.path] = d;
    if (c.status !== "D" && !d.binary) want.add(`head:${c.path}`);
  }
  // Every other file the page can open: an anchor's peek, a file a commit
  // lists though the net diff does not, a thread's file, an interface's site.
  const doc = data.document as {
    anchors?: Record<string, { peek?: { file: string; graph: string } }>;
    interfaces?: { entries: { file: string; graph: string }[] } | null;
  } | null;
  const side = (g: string) => (g === "base" ? "base" : "head");
  for (const a of Object.values(doc?.anchors ?? {}))
    if (a.peek) want.add(`${side(a.peek.graph)}:${a.peek.file}`);
  for (const e of doc?.interfaces?.entries ?? []) want.add(`${side(e.graph)}:${e.file}`);
  for (const c of commits) for (const f of c.files) if (!diffs[f]) want.add(`head:${f}`);
  for (const th of threads)
    if (th.target.type === "file") want.add(`${side(th.target.side)}:${th.target.path}`);
  const coverage = data.coverage as Coverage | null;
  for (const cluster of coverage?.clusters ?? [])
    for (const path of [
      ...cluster.explained,
      ...cluster.placed,
      ...cluster.searched,
      ...cluster.uncovered,
    ])
      want.add(`head:${path}`);
  for (const key of [...want].sort()) {
    const [graph, ...rest] = key.split(":");
    const path = rest.join(":");
    const g = side(graph!);
    const raw = await showFile(
      review.worktree,
      g === "base" ? review.pins.base : review.pins.head,
      path,
    );
    // a binary file has no lines to show, and its highlighted bytes would only bloat the page
    if (raw === null || raw.includes("\0")) continue;
    const f = await fileLines(review, path, g);
    if (f) files[key] = f;
  }
  return {
    payload: {
      // The worktree is a path on the author's machine; the published page has
      // no use for it and must not carry it.
      review: { ...review, worktree: "", repoRoot: "", dismissed: false },
      revision: review.revision,
      ...data,
      changes,
      threads,
      decisions: withThreads ? t.decisions : [],
      agent: NOBODY,
    },
    commits,
    diffs,
    files,
  };
}

function dataUri(type: string, bytes: Buffer): string {
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/** index.html's boot script, which picks the palette before the first paint. */
async function bootScript(): Promise<string> {
  const index = await readFile(join(UI_DIR, "index.html"), "utf8");
  return /<script>([\s\S]*?)<\/script>/.exec(index)?.[1]?.trim() ?? "";
}

async function appCss(): Promise<string> {
  let css = await readFile(join(UI_DIR, "app.css"), "utf8");
  for (const m of [...css.matchAll(/url\("\/(assets\/[^"]+\.woff2)"\)/g)])
    css = css.replace(m[0], `url("${dataUri("font/woff2", await readFile(join(UI_DIR, m[1]!)))}")`);
  return css;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/**
 * The published page: the same app the server serves, its data answered in
 * advance, as one file a browser opens from disk. The content security policy
 * forbids every fetch, so nothing in it can reach a network even by mistake.
 */
export async function exportReview(
  review: ReviewState,
  opts: {
    threads: boolean;
    banner?: { revision: number; sha: string; liveUrl?: string };
    markdown?: string;
  },
): Promise<string> {
  if (!existsSync(join(UI_DIR, "app.js")))
    throw new Error(`the bundled UI is missing at ${UI_DIR}; run \`pnpm build\``);
  const snap = {
    ...(await snapshot(review, opts.threads)),
    banner: opts.banner,
    markdown: opts.markdown,
    // What was sent, as the agent reads it: the page adds the reader's own
    // notes to it, and it has no way to fetch even its own feedback.md.
    feedback: (
      await exportMarkdown(review, review.revision, { sentOnly: true, threads: opts.threads })
    ).markdown,
  };
  const js = (await readFile(join(UI_DIR, "app.js"), "utf8"))
    .replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n")
    .replace(/<\/script/gi, "<\\/script");
  const json = JSON.stringify(snap).replace(/</g, "\\u003c");
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(review.title)} · thurview</title>
    <script>
${await bootScript()}
    </script>
    <style>
${await appCss()}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="application/json" id="thurview-snapshot">${json}</script>
    <script>
${js}
    </script>
  </body>
</html>
`;
}
