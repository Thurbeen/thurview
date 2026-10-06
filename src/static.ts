import { readFile, mkdir, rm } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  home, revisionDir, readJson, writeJson, writeText, writeReview,
  type ReviewState,
} from "./store.js";
import { exportMarkdown } from "./export-markdown.js";
import { exportReview } from "./export.js";

const execFileP = promisify(execFile);
export async function renderStatic(review: ReviewState, out: string, liveUrl?: string) {
  if (!review.revision) throw new Error("static snapshots require a published revision");
  const meta = await readJson<{ title: string; pins: ReviewState["pins"] }>(
    join(revisionDir(review.id, review.revision), "meta.json"));
  if (!meta) throw new Error("sealed revision is unavailable");
  const sealed = { ...review, title: meta.title, pins: meta.pins };
  const feedback = await exportMarkdown(sealed);
  const html = await exportReview(sealed, {
    threads: true,
    banner: { revision: review.revision, sha: meta.pins.head, liveUrl },
    markdown: "feedback.md",
  });
  await mkdir(out, { recursive: true });
  await writeText(join(out, "index.html"), html);
  await writeText(join(out, "feedback.md"), feedback.markdown);
  return { revision: review.revision, directory: out };
}

const Config = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  account_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  publicUrl: z.string().url().refine(s => {
    const u = new URL(s);
    return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
  }, "publicUrl must be an HTTPS origin"),
  allowLiveLink: z.boolean().default(false),
}).strict();

interface Archive { snapshots: Record<string, string> }
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "review";

export async function publishStatic(review: ReviewState, configPath: string) {
  const config = Config.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
  const target = createHash("sha256").update(JSON.stringify([config.name, config.account_id, config.publicUrl])).digest("hex");
  const root = join(home(), "static", target);
  await mkdir(root, { recursive: true });
  const lock = join(root, "deploy.lock");
  try { await mkdir(lock); } catch {
    throw new Error("another static deployment holds the archive lock; retry when it finishes");
  }
  try {
    const indexPath = join(root, "index.json");
    const index = await readJson<Archive>(indexPath) ?? { snapshots: {} };
    const path = index.snapshots[review.id] ?? `r/${slug(basename(review.repoRoot))}/${slug(review.binding.name)}/${randomBytes(16).toString("hex")}/`;
    // Persist the path before the remote call: even a lost deploy response
    // must retry at the same URL.
    index.snapshots[review.id] = path;
    await writeJson(indexPath, index);
    const assets = join(root, "assets");
    const live = config.allowLiveLink ? await readJson<{ port: number; hosts: string[] }>(join(home(), "server.json")) : null;
    const liveUrl = live ? `http://${live.hosts[0]}:${live.port}/review/${review.id}` : undefined;
    await renderStatic(review, join(assets, path), liveUrl);
    const wrangler = join(root, "wrangler.json");
    await writeJson(wrangler, {
      name: config.name,
      ...(config.account_id ? { account_id: config.account_id } : {}),
      compatibility_date: "2026-10-06",
      assets: { directory: assets, html_handling: "force-trailing-slash", not_found_handling: "404-page" },
    });
    try {
      await execFileP("wrangler", ["deploy", "--config", wrangler], {
        cwd: root, maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      // Wrangler output can contain account details: never copy it into AXI.
      throw new Error("wrangler deploy failed; check wrangler login and target configuration, then retry");
    }
    const url = new URL(path, config.publicUrl).href;
    review.staticSnapshot = { url, revision: review.revision };
    await writeReview(review);
    return { url, revision: review.revision, snapshots: Object.keys(index.snapshots).length };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
