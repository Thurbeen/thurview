import http from "node:http";
import { readFile } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileDiff } from "../diff.js";
import { highlightLines, languageFor } from "../highlight.js";
import { changedFiles, log, showFile, git, type ChangedFile } from "../git.js";
import { symbolIndex } from "../symbols.js";
import { registerTheme } from "../highlight.js";
import type { CompiledTheme } from "../theme.js";
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
  type ThreadTarget,
} from "../store.js";
import {
  createThread,
  replyThread,
  setThreadStatus,
  submitReview,
  deleteThread,
} from "../threads.js";

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

async function revisionData(id: string, n: number) {
  const dir = revisionDir(id, n);
  const [document, map, changes, meta, theme] = await Promise.all([
    readJson<unknown>(join(dir, "document.json")),
    readJson<unknown>(join(dir, "map.json")),
    readJson<ChangedFile[]>(join(dir, "changes.json")),
    readJson<unknown>(join(dir, "meta.json")),
    readJson<CompiledTheme>(join(dir, "theme.json")),
  ]);
  return {
    document,
    map,
    changes: changes ?? [],
    meta,
    theme: theme ? { name: theme.name, source: theme.source, css: theme.css } : null,
  };
}

/** Highlighter theme name for a review's presented revision (default skin when none). */
async function themeFor(id: string, revision: number): Promise<string | undefined> {
  if (!revision) return undefined;
  const t = await readJson<CompiledTheme>(join(revisionDir(id, revision), "theme.json"));
  return t ? registerTheme(t.shiki) : undefined;
}

const BLOB_TYPES: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  css: "text/css",
};

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

    if (!parts[2]) {
      const reviews = await listReviews();
      const out = [];
      for (const r of reviews) {
        const t = await readThreads(r.id);
        out.push({ ...r, openThreads: t.threads.filter((x) => x.status === "open").length });
      }
      return out;
    }
    const review = await findReview(parts[2]);
    const id = review.id;
    const sub = parts[3];

    if (!sub) {
      if (method === "DELETE") {
        await deleteReview(id);
        return { ok: true };
      }
      const n = Number(url.searchParams.get("revision") ?? review.revision);
      const data = review.revision
        ? await revisionData(id, n)
        : { document: null, map: null, changes: [], meta: null };
      const threads = await readThreads(id);
      return {
        review,
        revision: n,
        ...data,
        threads: threads.threads,
        decisions: threads.decisions,
      };
    }

    if (sub === "events") {
      throw new HttpError(500, "handled elsewhere");
    }
    if (sub === "revisions") {
      const out = [];
      for (let n = 1; n <= review.revision; n++)
        out.push(await readJson<unknown>(join(revisionDir(id, n), "meta.json")));
      return out.filter(Boolean) as unknown[];
    }
    if (sub === "changes") {
      return await changedFiles(review.worktree, review.pins.base, review.pins.head);
    }
    if (sub === "commits") {
      return await log(review.worktree, review.pins.base, review.pins.head);
    }
    if (sub === "diff") {
      const path = url.searchParams.get("path") ?? "";
      if (!path) throw new HttpError(400, "path required");
      const changes = await changedFiles(review.worktree, review.pins.base, review.pins.head);
      const entry = changes.find((c) => c.path === path);
      const oldPath = entry?.oldPath ?? path;
      const [oldText, newText] = await Promise.all([
        entry?.status === "A"
          ? Promise.resolve(null)
          : showFile(review.worktree, review.pins.base, oldPath),
        entry?.status === "D"
          ? Promise.resolve(null)
          : showFile(review.worktree, review.pins.head, path),
      ]);
      return (await buildFileDiff(
        path,
        oldText,
        newText,
        { old: `${review.pins.base}:${oldPath}`, new: `${review.pins.head}:${path}` },
        entry?.oldPath,
        await themeFor(id, review.revision),
      )) as unknown as Json;
    }
    if (sub === "file") {
      const path = url.searchParams.get("path") ?? "";
      const graph = url.searchParams.get("graph") === "base" ? "base" : "head";
      const commit = graph === "base" ? review.pins.base : review.pins.head;
      const text = await showFile(review.worktree, commit, path);
      if (text === null) throw new HttpError(404, `${path} not found at ${graph}`);
      const lang = languageFor(path);
      const all = await highlightLines(
        text,
        lang,
        `${commit}:${path}`,
        await themeFor(id, review.revision),
      );
      const from = Math.max(1, Number(url.searchParams.get("from") ?? 1));
      const to = Math.min(all.length, Number(url.searchParams.get("to") ?? all.length));
      return { path, graph, lang, total: all.length, from, to, lines: all.slice(from - 1, to) };
    }
    if (sub === "symbols") {
      const name = url.searchParams.get("name") ?? "";
      const graph = url.searchParams.get("graph") === "base" ? "base" : "head";
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
      const idx = symbolIndex(
        review.worktree,
        graph === "base" ? review.pins.base : review.pins.head,
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
      const decision = b["decision"] === "approve" ? "approve" : "request-changes";
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
        if (parts[1] === "reviews" && parts[3] === "blob" && parts[2]) {
          // raw file at the head commit, for theme fonts and images the reviewed project ships
          const review = await findReview(parts[2]);
          const path = url.searchParams.get("path") ?? "";
          const ext = path.split(".").pop()?.toLowerCase() ?? "";
          const type = BLOB_TYPES[ext];
          if (!path || !type) throw new HttpError(400, "path must name a font, image or css file");
          const text = await git(review.worktree, ["show", `${review.pins.head}:${path}`], {
            encoding: "buffer",
          });
          res.writeHead(200, {
            "content-type": type,
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(text);
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
