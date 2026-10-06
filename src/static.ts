import { readFile, mkdir, rm, access } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  home,
  revisionDir,
  readJson,
  readReview,
  listReviews,
  writeJson,
  writeText,
  reviewDir,
  type ReviewState,
} from "./store.js";
import { exportMarkdown } from "./export-markdown.js";
import { exportReview } from "./export.js";

const execFileP = promisify(execFile);
export async function renderStatic(review: ReviewState, out: string, liveUrl?: string) {
  if (!review.revision) throw new Error("static snapshots require a published revision");
  const meta = await readJson<{ title: string; pins: ReviewState["pins"] }>(
    join(revisionDir(review.id, review.revision), "meta.json"),
  );
  if (!meta) throw new Error("sealed revision is unavailable");
  const sealed = { ...review, title: meta.title, pins: meta.pins };
  const feedback = await exportMarkdown(sealed, sealed.revision, { sentOnly: true });
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

const Config = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    account_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    publicUrl: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === "https:" &&
          u.pathname === "/" &&
          !u.search &&
          !u.hash &&
          !u.username &&
          !u.password
        );
      }, "publicUrl must be an HTTPS origin"),
    allowLiveLink: z.boolean().default(false),
  })
  .strict();

interface Archive {
  account_id: string | null;
  snapshots: Record<string, string>;
}
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "review";

/** Read-only setup check, usable before there is a document to publish. */
export async function checkStaticTarget(configPath: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(configPath), "utf8"));
  } catch (e) {
    throw new Error(
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? "Cloudflare configuration is missing; save cloudflare.json first"
        : "Cloudflare configuration is unreadable or not valid JSON",
    );
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Cloudflare configuration has missing or invalid fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "target shape"))].join(", ")}`,
    );
  const config = parsed.data;
  if (config.allowLiveLink)
    throw new Error("set allowLiveLink to false before publishing a public review");
  const options = {
    cwd: dirname(resolve(configPath)),
    env: {
      ...process.env,
      ...(config.account_id ? { CLOUDFLARE_ACCOUNT_ID: config.account_id } : {}),
      WRANGLER_SEND_METRICS: "false",
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  };
  try {
    await execFileP("wrangler", ["whoami", "--json"], options);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("wrangler is missing; install the checked latest stable release");
    throw new Error("Cloudflare login is unavailable; run wrangler login --device and retry");
  }
  try {
    await execFileP(
      "wrangler",
      ["deployments", "status", "--name", config.name, "--json"],
      options,
    );
  } catch {
    throw new Error(
      "Cloudflare project is missing or inaccessible; check the account and create the Worker first",
    );
  }
  return { ready: true, project: config.name };
}

export async function publishStatic(
  review: ReviewState,
  configPath: string,
  initializeArchive = false,
) {
  const config = Config.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
  const target = createHash("sha256").update(config.name).digest("hex");
  const root = join(home(), "static", target);
  await mkdir(root, { recursive: true });
  const lock = join(root, "deploy.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("another static deployment holds the archive lock; retry when it finishes");
  }
  try {
    const indexPath = join(root, "index.json");
    let index: Archive;
    try {
      index = z
        .object({
          account_id: z.string().nullable().default(null),
          snapshots: z.record(
            z.string(),
            z.string().regex(/^r\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-f0-9]{32}\/$/),
          ),
        })
        .parse(JSON.parse(await readFile(indexPath, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("static archive index is unreadable; restore it before deploying");
      if (!initializeArchive)
        throw new Error(
          "static archive is missing; restore it, or use --initialize-archive only for a Worker with no existing snapshots",
        );
      const prior = (await listReviews()).some(
        (r) =>
          r.staticSnapshot &&
          (r.staticSnapshot.target === config.name ||
            new URL(r.staticSnapshot.url).origin === new URL(config.publicUrl).origin),
      );
      if (prior)
        throw new Error(
          "existing snapshot URLs require restoring the archive, not initializing it",
        );
      index = { account_id: config.account_id ?? null, snapshots: {} };
    }
    if (index.account_id !== (config.account_id ?? null))
      throw new Error(
        "configured account differs from this archive; restore its original target configuration",
      );
    const assets = join(root, "assets");
    for (const prior of Object.values(index.snapshots)) {
      try {
        await access(join(assets, prior, "index.html"));
        await access(join(assets, prior, "feedback.md"));
      } catch {
        throw new Error("static archive is incomplete; restore its assets before deploying");
      }
    }
    const path =
      index.snapshots[review.id] ??
      `r/${slug(basename(review.repoRoot))}/${slug(review.binding.name)}/${randomBytes(16).toString("hex")}/`;
    // Persist the path before the remote call: even a lost deploy response
    // must retry at the same URL.
    index.snapshots[review.id] = path;
    const live = config.allowLiveLink
      ? await readJson<{ port: number; hosts: string[] }>(join(home(), "server.json"))
      : null;
    const liveUrl = live ? `http://${live.hosts[0]}:${live.port}/review/${review.id}` : undefined;
    await renderStatic(review, join(assets, path), liveUrl);
    await writeJson(indexPath, index);
    const wrangler = join(root, "wrangler.json");
    await writeJson(wrangler, {
      name: config.name,
      ...(config.account_id ? { account_id: config.account_id } : {}),
      compatibility_date: "2026-10-06",
      assets: {
        directory: assets,
        html_handling: "force-trailing-slash",
        not_found_handling: "404-page",
      },
    });
    try {
      await execFileP("wrangler", ["deploy", "--config", wrangler], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      // Wrangler output can contain account details: never copy it into AXI.
      throw new Error(
        "wrangler deploy failed; check wrangler login and target configuration, then retry",
      );
    }
    const url = new URL(path, config.publicUrl).href;
    const current = await readReview(review.id);
    if (!current)
      throw new Error(
        "snapshot deployed, but the review was removed before its URL could be recorded",
      );
    await writeJson(join(reviewDir(review.id), "static.json"), {
      url,
      revision: review.revision,
      target: config.name,
    });
    return { url, revision: review.revision, snapshots: Object.keys(index.snapshots).length };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
