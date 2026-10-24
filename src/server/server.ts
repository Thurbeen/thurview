import http from "node:http";
import { readFile } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileDiff, type FileDiff } from "../diff.js";
import { highlightLines, languageFor } from "../highlight.js";
import { changedFiles, log, showFile, type ChangedFile } from "../git.js";
import { symbolIndex } from "../symbols.js";
import type { Verdict } from "../pr-review/format.js";
import type { Provenance } from "../forge/types.js";
import {
  listReviews,
  readReview,
  writeReview,
  readThreads,
  readJson,
  reviewDir,
  revisionDir,
  deleteReview,
  writeJson,
  serverStateFile,
  type ReviewState,
  type ThreadTarget,
} from "../store.js";
import { queue } from "../queue.js";
import {
  createThread,
  replyThread,
  setThreadStatus,
  submitReview,
  deleteThread,
} from "../threads.js";
import { presenceOf } from "../presence.js";
import {
  allowsEverything,
  changeInScope,
  scopeAt,
  OPEN_SCOPE,
  SCOPE_FILE,
  type ReviewScope,
  type SealedRules,
} from "../scope.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

type Json = Record<string, unknown> | unknown[] | null;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: http.ServerResponse,
  status: number,
  body: Json | string,
  type = "application/json",
): void {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type":
      type + (type.startsWith("text") || type.includes("json") ? "; charset=utf-8" : ""),
    "cache-control": "no-store",
  });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

async function findReview(idOrPrefix: string) {
  const r = await readReview(idOrPrefix);
  if (r) return r;
  const all = (await listReviews()).filter((x) => x.id.startsWith(idOrPrefix));
  if (all.length === 1) return all[0]!;
  throw new HttpError(404, all.length ? "ambiguous review id" : "review not found");
}

/** The scope stamp a revision's `meta.json` carries, with the shape old revisions have. */
function sealedRules(meta: unknown): SealedRules & { digest: string; withheld: number | null } {
  const s =
    meta && typeof meta === "object" && "scope" in meta
      ? (
          meta as {
            scope?: {
              declared?: boolean;
              digest?: string;
              extensions?: string[];
              filenames?: string[];
              exclude?: string[];
              withheld?: number;
            };
          }
        ).scope
      : undefined;
  return {
    declared: s?.declared ?? false,
    digest: s?.digest ?? OPEN_SCOPE.digest,
    extensions: s?.extensions ?? [],
    filenames: s?.filenames ?? [],
    exclude: s?.exclude ?? [],
    withheld: typeof s?.withheld === "number" ? s.withheld : null,
  };
}

/**
 * A revision is read back exactly as it was sealed, so the rules it was sealed
 * under have to match the rules in force. They come apart in one ordinary way:
 * a repository adds or narrows `thurview-scope.yaml` after a revision was
 * published, and that revision still holds the peeked source, the file list and
 * the coverage listing from before. Serving it would be the "declared but not
 * enforced" failure by the back door, so it is refused and the message names the
 * one command that fixes it.
 *
 * Widening the rules is not that case: a revision holds only what the rules in
 * force when it was sealed let in, so if every path those rules allowed is still
 * allowed, there is nothing in it to withhold and refusing it would cost the
 * reader the history for nothing. The stamp records the rules in full so that
 * question can be asked at all.
 *
 * A revision sealed before this stamp existed carries no `scope`. That reads as
 * "sealed under no rules", which is what it was, so it is served unchanged while
 * no rules are declared and refused once some are.
 */
export function requireRevisionUnderScope(meta: unknown, n: number, scope: ReviewScope): void {
  const sealed = sealedRules(meta);
  if (sealed.digest === scope.digest) return;
  if (allowsEverything(scope, sealed)) return;
  throw new HttpError(
    409,
    `excluded by scope: revision ${n} was sealed under different rules than ${SCOPE_FILE} declares at the pinned head commit, so what it holds cannot be shown under the rules in force. Run \`thurview publish\` to seal a revision under them.`,
  );
}

type Pins = { base: string; head: string };
type SealedPeek = {
  file: string;
  from: number;
  to: number;
  graph: "base" | "head";
  lang: string;
  lines: string[];
};

/**
 * A sealed peek carries its excerpt highlighted inline, in the palette of the
 * thurview that sealed it. Highlight it again from the pinned commit so every
 * revision, however old, reads in the reader's palette.
 */
async function rehighlightPeeks(document: unknown, worktree: string, pins: Pins): Promise<void> {
  const anchors = (document as { anchors?: Record<string, { peek?: SealedPeek }> } | null)?.anchors;
  for (const a of Object.values(anchors ?? {})) {
    const peek = a.peek;
    if (!peek) continue;
    const commit = peek.graph === "base" ? pins.base : pins.head;
    const text = await showFile(worktree, commit, peek.file);
    if (text === null) {
      // the commit is gone: keep the text, drop a colour picked for another ground
      peek.lines = peek.lines.map((l) => l.replace(/color:#[0-9a-f]{3,8};?/gi, ""));
      continue;
    }
    const all = await highlightLines(text, peek.lang, `${commit}:${peek.file}`);
    peek.lines = all.slice(peek.from - 1, peek.to);
  }
}

export async function revisionData(
  review: { id: string; worktree: string; pins: Pins },
  n: number,
) {
  const id = review.id;
  const dir = revisionDir(id, n);
  const [document, map, changes, coverage, meta, verdict, provenance] = await Promise.all([
    readJson<unknown>(join(dir, "document.json")),
    readJson<unknown>(join(dir, "map.json")),
    readJson<ChangedFile[]>(join(dir, "changes.json")),
    readJson<unknown>(join(dir, "coverage.json")),
    readJson<unknown>(join(dir, "meta.json")),
    readJson<Verdict>(join(dir, "verdict.json")),
    readJson<Provenance>(join(dir, "provenance.json")),
  ]);
  requireRevisionUnderScope(meta, n, await scopeOf(review));
  const sealedPins = (meta as { pins?: Pins } | null)?.pins ?? review.pins;
  await rehighlightPeeks(document, review.worktree, sealedPins);
  return {
    // A revision is read back exactly as it was sealed, so one from before a
    // field existed simply lacks it. The browser is written for a field that is
    // absent by being null, not by being missing, so fill it here rather than
    // teach every reader of the document two ways to be absent.
    document:
      document && typeof document === "object"
        ? { security: null, architecture: null, ...document }
        : document,
    map,
    changes: changes ?? [],
    coverage,
    meta,
    /** the review's verdict, when it was published with its pass; null otherwise */
    verdict: verdict ?? null,
    /** who wrote the change request and what its forge verified of the head; null when not read */
    provenance: provenance ?? null,
  };
}

/** One changed file's diff between the review's pins, highlighted. */
export async function fileDiff(review: ReviewState, path: string): Promise<FileDiff> {
  const scope = await scopeOf(review);
  requireInScope(scope, path);
  const changes = await changedFiles(review.worktree, review.pins.base, review.pins.head);
  const entry = changes.find((c) => c.path === path);
  const oldPath = entry?.oldPath ?? path;
  requireInScope(scope, oldPath);
  const [oldText, newText] = await Promise.all([
    entry?.status === "A"
      ? Promise.resolve(null)
      : showFile(review.worktree, review.pins.base, oldPath),
    entry?.status === "D"
      ? Promise.resolve(null)
      : showFile(review.worktree, review.pins.head, path),
  ]);
  return buildFileDiff(
    path,
    oldText,
    newText,
    { old: `${review.pins.base}:${oldPath}`, new: `${review.pins.head}:${path}` },
    entry?.oldPath,
  );
}

/** Every highlighted line of one file at a pinned commit, or null when it is not there. */
export async function fileLines(
  review: ReviewState,
  path: string,
  graph: "head" | "base",
): Promise<{
  path: string;
  graph: "head" | "base";
  lang: string;
  total: number;
  lines: string[];
} | null> {
  requireInScope(await scopeOf(review), path);
  const commit = graph === "base" ? review.pins.base : review.pins.head;
  const text = await showFile(review.worktree, commit, path);
  if (text === null) return null;
  const lang = languageFor(path);
  const lines = await highlightLines(text, lang, `${commit}:${path}`);
  return { path, graph, lang, total: lines.length, lines };
}

export function tailscaleAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (name.startsWith("tailscale") || (o1 === 100 && (o2 ?? 0) >= 64 && (o2 ?? 0) <= 127))
        out.push(a.address);
    }
  }
  return out;
}

/**
 * The review scope the reviewed repository declares at the pinned head commit.
 *
 * HTTP and export share the guarded file readers. Symbols and commit file
 * lists are filtered separately because they do not go through those readers.
 *
 * Malformed rules fail the request rather than falling back to an open scope.
 * `publish` refuses a document whose rules do not parse, so this is the case
 * where somebody edited the file after publishing; answering as though no scope
 * were declared is the one outcome that must not happen.
 */
export async function scopeOf(review: { worktree: string; pins: Pins }): Promise<ReviewScope> {
  try {
    return await scopeAt(review.worktree, review.pins.head);
  } catch (e) {
    throw new HttpError(
      500,
      `${SCOPE_FILE} at the pinned head commit does not parse, so the review scope it declares cannot be applied: ${(e as Error).message}`,
    );
  }
}

/**
 * Refuse an excluded path by saying so. A 404 would claim the file does not
 * exist, when it does and was withheld on purpose - and a reviewer who reads
 * that as a defect in the tool goes and opens the file by hand, which is the
 * opposite of what the rules are for.
 */
function requireInScope(scope: ReviewScope, path: string): void {
  if (!scope.inScope(path))
    throw new HttpError(
      403,
      `${path} is excluded by scope: the review scope this repository declares in ${SCOPE_FILE} does not allow it`,
    );
}

export interface ServerHandle {
  port: number;
  hosts: string[];
  close(): Promise<void>;
}

export async function startServer(
  opts: { port?: number; hosts?: string[] } = {},
): Promise<ServerHandle> {
  const clients = new Map<string, Set<http.ServerResponse>>();
  const watchers = new Map<string, ReturnType<typeof watch>>();

  function subscribe(id: string, res: http.ServerResponse) {
    let set = clients.get(id);
    if (!set) {
      set = new Set();
      clients.set(id, set);
    }
    set.add(res);
    if (!watchers.has(id) && existsSync(reviewDir(id))) {
      let timer: NodeJS.Timeout | null = null;
      const w = watch(reviewDir(id), () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          for (const c of clients.get(id) ?? [])
            c.write(`data: ${JSON.stringify({ type: "change" })}\n\n`);
        }, 150);
      });
      watchers.set(id, w);
    }
    res.on("close", () => {
      set!.delete(res);
      if (set!.size === 0) {
        watchers.get(id)?.close();
        watchers.delete(id);
        clients.delete(id);
      }
    });
  }

  async function api(req: http.IncomingMessage, url: URL): Promise<Json> {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const method = req.method ?? "GET";
    if (parts[1] === "health") return { ok: true, pid: process.pid };
    if (parts[1] !== "reviews") throw new HttpError(404, "not found");

    if (!parts[2]) return (await queue(await listReviews())) as unknown as Json;
    const review = await findReview(parts[2]);
    const id = review.id;
    const sub = parts[3];

    if (!sub) {
      if (method === "DELETE") {
        await deleteReview(id);
        return { ok: true };
      }
      const n = Number(url.searchParams.get("revision") ?? review.revision);
      const scopeNow = await scopeOf(review);
      const data = review.revision
        ? await revisionData(review, n)
        : { document: null, map: null, changes: [], coverage: null, meta: null };
      // Keyed on "a revision was published", not on "meta.json is there": that
      // file is written last, so a revision left half-written by an interrupted
      // publish has a document.json and no stamp, and a guard hung on the stamp
      // would wave it through with the peeks the rules in force now withhold.
      if (review.revision) requireRevisionUnderScope(data.meta, n, scopeNow);
      const threads = await readThreads(id);
      // The sealed revision was filtered when it was published, so what is left
      // to tell the reader is that something WAS withheld and by which rules.
      // A shorter file list than the change really has, with nothing saying so,
      // is worse for the reader than seeing all of it.
      //
      // The count comes from the revision, not from the pins: it has to describe
      // the file list next to it. Counted live it would say "3 withheld" over a
      // list sealed when one was, the moment the reviewer re-pinned to pick up
      // new commits - and it would put a `git diff` on a page that is otherwise
      // read entirely off disk, so a review whose repository has moved away
      // answered 500 instead of serving what it had sealed.
      const scope = scopeNow;
      const withheld = sealedRules(data.meta).withheld;
      return {
        review,
        revision: n,
        ...data,
        scope: {
          declared: scope.declared,
          verdict: scope.verdict,
          extensions: scope.extensions,
          filenames: scope.filenames,
          exclude: scope.exclude,
          withheld,
        },
        threads: threads.threads,
        decisions: threads.decisions,
        agent: await presenceOf(id),
      };
    }

    if (sub === "events") {
      throw new HttpError(500, "handled elsewhere");
    }
    if (sub === "presence") return (await presenceOf(id)) as unknown as Json;
    if (sub === "revisions") {
      const out = [];
      for (let n = 1; n <= review.revision; n++)
        out.push(await readJson<unknown>(join(revisionDir(id, n), "meta.json")));
      return out.filter(Boolean) as unknown[];
    }
    if (sub === "changes") {
      const scope = await scopeOf(review);
      return (await changedFiles(review.worktree, review.pins.base, review.pins.head)).filter((c) =>
        changeInScope(scope, c),
      );
    }
    if (sub === "commits") {
      // A path scope is about paths, so the per-commit file list is filtered and
      // the message is not. Commit prose is content nobody thinks of as part of
      // a review and no path rule touches it; README says so where it says what
      // the scope does not cover.
      const scope = await scopeOf(review);
      return (await log(review.worktree, review.pins.base, review.pins.head)).map((c) => ({
        ...c,
        files: c.files.filter((f) => scope.inScope(f)),
      }));
    }
    if (sub === "diff") {
      const path = url.searchParams.get("path") ?? "";
      if (!path) throw new HttpError(400, "path required");
      return (await fileDiff(review, path)) as unknown as Json;
    }
    if (sub === "file") {
      const path = url.searchParams.get("path") ?? "";
      const graph = url.searchParams.get("graph") === "base" ? "base" : "head";
      const f = await fileLines(review, path, graph);
      if (!f) throw new HttpError(404, `${path} not found at ${graph}`);
      const from = Math.max(1, Number(url.searchParams.get("from") ?? 1));
      const to = Math.min(f.total, Number(url.searchParams.get("to") ?? f.total));
      return { ...f, from, to, lines: f.lines.slice(from - 1, to) };
    }
    if (sub === "symbols") {
      const name = url.searchParams.get("name") ?? "";
      const graph = url.searchParams.get("graph") === "base" ? "base" : "head";
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
      const idx = symbolIndex(
        review.worktree,
        graph === "base" ? review.pins.base : review.pins.head,
        await scopeOf(review),
      );
      return (await idx.lookup(name)).slice(0, 20);
    }
    if (sub === "threads") {
      const tid = parts[4];
      if (method === "GET") return (await readThreads(id)).threads;
      if (method === "POST" && !tid) {
        const b = await readBody(req);
        const body = String(b["body"] ?? "").trim();
        if (!body) throw new HttpError(400, "body required");
        return createThread(id, {
          kind: b["kind"] === "question" ? "question" : "comment",
          mode: b["mode"] === "ask" ? "ask" : "review",
          target: (b["target"] as ThreadTarget) ?? { type: "review" },
          body,
        }) as unknown as Json;
      }
      if (method === "POST" && tid) {
        const action = parts[5];
        const b = await readBody(req);
        if (action === "reply")
          return replyThread(
            id,
            tid,
            b["role"] === "agent" ? "agent" : "reviewer",
            String(b["body"] ?? ""),
          ) as unknown as Json;
        if (action === "resolve") return setThreadStatus(id, tid, "resolved") as unknown as Json;
        if (action === "reopen") return setThreadStatus(id, tid, "open") as unknown as Json;
        if (action === "delete") {
          await deleteThread(id, tid);
          return { ok: true };
        }
      }
      throw new HttpError(404, "not found");
    }
    if (sub === "submit" && method === "POST") {
      const b = await readBody(req);
      const decision =
        b["decision"] === "approve"
          ? "approve"
          : b["decision"] === "close"
            ? "close"
            : "request-changes";
      const body = String(b["body"] ?? "").trim();
      const t = await submitReview(id, decision, body || undefined);
      return { review: await readReview(id), decisions: t.decisions };
    }
    if (sub === "dismiss" && method === "POST") {
      const b = await readBody(req);
      review.dismissed = b["dismissed"] !== false;
      await writeReview(review);
      return review as unknown as Json;
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[1] === "reviews" && parts[3] === "events" && parts[2]) {
          const review = await findReview(parts[2]);
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
          subscribe(review.id, res);
          const ping = setInterval(() => res.write(": ping\n\n"), 25000);
          res.on("close", () => clearInterval(ping));
          return;
        }
        const body = await api(req, url);
        send(res, 200, body);
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        const rel = url.pathname
          .slice(1)
          .split("/")
          .filter((p) => p && p !== "..")
          .join("/");
        const type = rel.endsWith(".woff2")
          ? "font/woff2"
          : rel.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
        let data: Buffer;
        try {
          data = await readFile(join(UI_DIR, rel));
        } catch {
          throw new HttpError(404, "asset not found");
        }
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(data);
        return;
      }
      const file =
        url.pathname === "/app.js"
          ? "app.js"
          : url.pathname === "/app.css"
            ? "app.css"
            : "index.html";
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html";
      send(res, 200, await readFile(join(UI_DIR, file), "utf8"), type);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: (e as Error).message });
    }
  });

  // Warm the syntax highlighter so the first diff does not pay the grammar load.
  void highlightLines("const warm = 1;\n", "typescript").catch(() => {});
  const hosts = opts.hosts ?? ["127.0.0.1", ...tailscaleAddresses()];
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, hosts[0], () =>
      resolve((server.address() as { port: number }).port),
    );
  });
  const extra: http.Server[] = [];
  for (const h of hosts.slice(1)) {
    const s = http.createServer(server.listeners("request")[0] as http.RequestListener);
    await new Promise<void>((resolve) => {
      s.once("error", () => resolve());
      s.listen(port, h, () => resolve());
    });
    extra.push(s);
  }
  await writeJson(serverStateFile(), {
    pid: process.pid,
    port,
    hosts,
    startedAt: new Date().toISOString(),
  });
  return {
    port,
    hosts,
    close: async () => {
      for (const s of [server, ...extra]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      for (const w of watchers.values()) w.close();
    },
  };
}
