import {
  runAxiCli,
  AxiError,
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, symlink, lstat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import * as g from "./git.js";
import {
  SCHEMA,
  home,
  newId,
  now,
  readReview,
  writeReview,
  listReviews,
  reviewsFor,
  reviewDir,
  revisionDir,
  readThreads,
  readText,
  writeText,
  writeJson,
  readJson,
  serverStateFile,
  deleteReview,
  kindOf,
  type ReviewState,
  type Binding,
  type DocumentKind,
  type Thread,
  type ThreadTarget,
} from "./store.js";
import { compileDocument, compileMap, globToRegExp, type Diagnostic } from "./document/compile.js";
import {
  computeCoverage,
  scopeGlob,
  scopeGraph,
  scopeTruncated,
  type Coverage,
} from "./coverage.js";
import type { CodeGraph } from "./graph.js";
import type { InterfaceDelta } from "./interfaces.js";
import { parseTheme, compileTheme, type CompiledTheme } from "./theme.js";
import { registerTheme } from "./highlight.js";
import { replyThread, setThreadStatus, needsAgent } from "./threads.js";
import { attach } from "./presence.js";
import { startServer } from "./server/server.js";
import { parseFlags, helpFor, str, bool, type FlagSpec } from "./flags.js";
import { VERSION } from "./version.js";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTION =
  "Guided, evidence-anchored reviews of a change and explainers of a codebase, read and answered in the browser";
type Out = Record<string, unknown>;

function note(msg: string): void {
  process.stderr.write(msg + "\n");
}
function short(id: string): string {
  return id.slice(0, 8);
}
function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}... (truncated, ${text.length} chars total)`
    : text;
}
function targetLabel(t: ThreadTarget): string {
  if (t.type === "document") return `document${t.quote ? ` "${truncate(t.quote, 40)}"` : ""}`;
  if (t.type === "file") {
    if (!t.line) return `${t.path} (file)`;
    const range = t.endLine && t.endLine > t.line ? `${t.line}-${t.endLine}` : String(t.line);
    return `${t.path}:${range}${t.side === "base" ? " (base)" : ""}`;
  }
  if (t.type === "map") return `map ${t.node}`;
  return "review";
}
function lastMessage(t: Thread): string {
  const m = t.messages[t.messages.length - 1];
  return m ? `${m.role}: ${truncate(m.body.replace(/\s+/g, " "), 120)}` : "";
}

async function worktreeOf(cwd: string): Promise<string | null> {
  try {
    return await g.repoRoot(cwd);
  } catch {
    return null;
  }
}

async function resolveReview(idOpt: string | undefined): Promise<ReviewState> {
  if (idOpt) {
    const r = await readReview(idOpt);
    if (r) return r;
    const m = (await listReviews()).filter((x) => x.id.startsWith(idOpt));
    if (m.length === 1) return m[0]!;
    throw new AxiError(
      m.length ? `review id ${idOpt} is ambiguous` : `review ${idOpt} not found`,
      "NOT_FOUND",
      ["Run `thurview info --all` to list reviews"],
    );
  }
  const worktree = await worktreeOf(process.cwd());
  if (!worktree)
    throw new AxiError("not inside a git repository", "VALIDATION_ERROR", [
      "Run inside the source worktree, or pass --review <id>",
    ]);
  const mine = (await reviewsFor(worktree)).filter(
    (r) => !r.dismissed && r.status !== "accepted" && r.status !== "closed",
  );
  if (mine.length === 1) return mine[0]!;
  if (mine.length)
    throw new AxiError("several active reviews for this worktree", "VALIDATION_ERROR", [
      "Pass --review <id>; run `thurview info` to list them",
    ]);
  throw new AxiError("no active review for this worktree", "NOT_FOUND", [
    "Run `thurview scaffold` to create one",
  ]);
}

async function reviewRow(r: ReviewState, fields: Set<string>): Promise<Out> {
  const t = await readThreads(r.id);
  const row: Out = {
    id: short(r.id),
    kind: kindOf(r),
    title: r.title,
    status: r.status,
    rev: r.revision,
    open: t.threads.filter((x) => x.status === "open").length,
    needsAgent: t.threads.filter(needsAgent).length,
  };
  if (fields.has("all") || fields.has("binding"))
    row["binding"] = r.binding.kind === "pr" ? `PR #${r.binding.name}` : r.binding.name;
  if (fields.has("all") || fields.has("pins"))
    row["pins"] =
      kindOf(r) === "explainer"
        ? r.pins.head.slice(0, 12)
        : `${r.pins.base.slice(0, 12)}..${r.pins.head.slice(0, 12)}`;
  if (fields.has("all") || fields.has("worktree")) row["worktree"] = r.worktree;
  if (fields.has("all") || fields.has("inSync"))
    row["inSync"] = await g
      .revParse(r.worktree, "HEAD")
      .then((h) => h === r.pins.head)
      .catch(() => null);
  if (fields.has("all") || fields.has("dismissed")) row["dismissed"] = r.dismissed;
  if (fields.has("all") || fields.has("updatedAt")) row["updatedAt"] = r.updatedAt;
  if (fields.has("all") || fields.has("uuid")) row["uuid"] = r.id;
  return row;
}

function publicUrl(port: number, hosts: string[], dns?: string): string {
  const host = dns ? dns.replace(/\.$/, "") : (hosts.find((h) => h !== "127.0.0.1") ?? "localhost");
  return `http://${host}:${port}`;
}
async function tailscaleDns(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("tailscale", ["status", "--json"], { timeout: 3000 });
    return (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName || undefined;
  } catch {
    return undefined;
  }
}
async function serverAlive(): Promise<{ port: number; hosts: string[] } | null> {
  const st = await readJson<{ port: number; hosts: string[] }>(serverStateFile());
  if (!st) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return st;
  } catch {
    /* dead */
  }
  return null;
}
async function ensureServer(): Promise<{ port: number; hosts: string[] }> {
  const alive = await serverAlive();
  if (alive) return alive;
  const child = spawn(process.execPath, [join(HERE, "main.js"), "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const st = await serverAlive();
    if (st) return st;
  }
  throw new AxiError("the review server did not start", "SERVER_ERROR", [
    "Run `thurview serve` in a terminal to see why",
  ]);
}
function reviewUrl(base: string, id: string, view?: string): string {
  return `${base}/review/${id}${view ? `#/${view}` : ""}`;
}
/**
 * The interface delta at a review's pins. The graphs are cached per commit under
 * the review directory, so publish and `graph interfaces` build them once between
 * them; both modules load lazily to keep tree-sitter off every other command's path.
 */
async function deltaFor(
  review: ReviewState,
  base?: CodeGraph,
  head?: CodeGraph,
): Promise<InterfaceDelta> {
  const graph = await import("./graph.js");
  const { interfaceDelta } = await import("./interfaces.js");
  const dir = reviewDir(review.id);
  const b = base ?? (await graph.graphAt(review.worktree, review.pins.base, dir));
  const h = head ?? (await graph.graphAt(review.worktree, review.pins.head, dir));
  const changes = await g.lineChanges(review.worktree, review.pins.base, review.pins.head);
  const changed = await g.changedFiles(review.worktree, review.pins.base, review.pins.head);
  return interfaceDelta({
    cwd: review.worktree,
    pins: review.pins,
    base: b,
    head: h,
    impact: graph.impact(b, h, changes, 1),
    changes,
    changed,
  });
}

async function guidanceFiles(repoRoot: string): Promise<string[]> {
  return [join(home(), "THURVIEW.md"), join(repoRoot, "THURVIEW.md")].filter((p) => existsSync(p));
}

// The stub is what the reader sees when the agent publishes before writing, so
// it reads as a notice rather than as a form to fill in.
const TEMPLATE_MD = (title: string) => `# ${title}

**Summary**

- The agent is still writing this walkthrough. The Files tab already shows
  the change at the pinned commits; this page offers the new revision when
  the walkthrough lands.
`;
const TEMPLATE_DATA = `# Typed inputs for review.md: actors, anchors and stores. Every shape is in the
# thurview skill, references/components.md. An anchor names a line range at a
# pinned commit; review.md links to it with [text](anchor:<id>) or shows it
# inline with a peek fence holding <id>. Example:
#
# anchors:
#   spawn:
#     title: PTY spawn site
#     peek: { file: src/pty.ts, from: 214, to: 223 }   # add graph: base for the old side
#
# interfaces holds one capability line per interface the change moved. thurview
# derives the list itself; run \`thurview graph interfaces\` for the ids.
actors: {}
anchors: {}
stores: {}
interfaces: {}
`;
const TEMPLATE_MAP = `# Software map: where this change landed in the system, and what sits next to it.
# People, systems, containers, components, code. Leave nodes empty when the change
# lands in one place and the Files tab already answers that.
nodes: []
edges: []
`;
const TEMPLATE_THEME = `# Look of this review, derived from the reviewed project's own design system.
# Leave this file empty (or delete it) for the default skin. See the thurview skill
# reference (references/theme.md) for every key. Example:
#
# name: acme-web
# source: tailwind.config.ts, src/styles/tokens.css
# mode: light
# colors: { bg: "#ffffff", bg2: "#f6f7f9", fg: "#111827", fg2: "#4b5563", muted: "#9ca3af", line: "#e5e7eb", accent: "#2563eb", link: "#2563eb", ok: "#16a34a", warn: "#d97706", del: "#dc2626" }
# fonts: { display: "Inter, sans-serif", body: "Inter, sans-serif", mono: "'JetBrains Mono', monospace", stylesheets: ["https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"] }
# shape: { radius: 8px, bevel: false, glow: false, scanlines: false, headingTransform: none }
# code: { keyword: "#7c3aed", string: "#15803d", function: "#b45309", variable: "#0369a1", comment: "#9ca3af" }
`;

const TEMPLATE_EXPLAIN_MD = (title: string) => `# ${title}

**Summary**

- The agent is still writing this explainer. The Coverage tab already states
  what it has and has not examined at the pinned commit; this page offers the
  new revision when the walkthrough lands.
`;
const TEMPLATE_EXPLAIN_DATA = `# Typed inputs for the explainer: actors, anchors and stores. An explainer has
# one pinned commit, so every anchor reads that commit and \`graph: base\` is an
# error. It has no interface delta: there is no change to take one from.
#
# anchors:
#   dispatch:
#     title: where a request picks its handler
#     peek: { file: src/server/router.ts, from: 41, to: 58 }
actors: {}
anchors: {}
stores: {}
`;
const TEMPLATE_EXPLAIN_MAP = `# The structure of the code at the pinned commit: systems, containers,
# components, code. The map carries breadth so the prose can carry depth, and a
# node's \`files\` globs are what tell the Coverage tab a file was at least placed.
# Seed it from \`thurview graph architecture\`.
nodes: []
edges: []
`;

// ---- commands ----

const SPECS: Record<
  string,
  { description: string; flags: FlagSpec; examples: string[]; args?: string }
> = {
  scaffold: {
    description: "Create a review pinned to exact base and head commits, or re-pin one",
    flags: {
      pr: { kind: "string", help: "review a GitHub pull request (number or URL, needs gh)" },
      base: { kind: "string", help: "base revision (default: trunk fork point)" },
      head: { kind: "string", help: "head revision (default: current branch)" },
      title: { kind: "string", help: "initial title" },
      new: { kind: "boolean", help: "create another review even if one matches the binding" },
      update: { kind: "boolean", help: "re-pin an existing review from its binding" },
      review: { kind: "string", help: "review to update (id prefix)" },
    },
    examples: [
      "thurview scaffold",
      "thurview scaffold --pr 123",
      "thurview scaffold --base main --head HEAD",
      "thurview scaffold --update --review <id>",
    ],
  },
  explain: {
    description:
      "Create a code explainer pinned to one commit: a whole codebase, or one subsystem of it",
    args: "[<path scope>]",
    flags: {
      commit: { kind: "string", help: "commit to pin (default: HEAD)" },
      title: { kind: "string", help: "initial title" },
      new: { kind: "boolean", help: "create another explainer even if one matches the scope" },
      update: { kind: "boolean", help: "re-pin an existing explainer to a new commit" },
      review: { kind: "string", help: "explainer to update (id prefix)" },
    },
    examples: [
      "thurview explain",
      "thurview explain src/server",
      "thurview explain --commit v1.2.0",
      "thurview explain --update --review <id>",
    ],
  },
  info: {
    description: "Reviews and explainers bound to this worktree (or all of them with --all)",
    flags: {
      all: { kind: "boolean", help: "every review, not only this worktree" },
      fields: {
        kind: "string",
        help: "extra columns: binding,pins,worktree,inSync,dismissed,updatedAt,uuid or all",
      },
    },
    examples: ["thurview info", "thurview info --all --fields pins,inSync"],
  },
  publish: {
    description:
      "Validate review.md, data.yaml, map.yaml and theme.yaml against the pins and seal a revision",
    flags: {
      review: {
        kind: "string",
        help: "review id prefix (default: the active review for this worktree)",
      },
      view: { kind: "string", help: "tab the reader lands on: review, commits, files, map" },
      open: { kind: "boolean", help: "open the browser after publishing" },
    },
    examples: ["thurview publish", "thurview publish --review <id> --view files --open"],
  },
  open: {
    description: "Start the server if needed and open the review in the browser",
    flags: {
      review: { kind: "string", help: "review id prefix" },
      view: { kind: "string", help: "review, commits, files or map" },
      browser: {
        kind: "boolean",
        help: "launch a browser (use --no-browser to only print the url)",
      },
    },
    examples: ["thurview open", "thurview open --review <id> --view map --no-browser"],
  },
  serve: {
    description: "Run the review server in the foreground",
    flags: {
      port: { kind: "string", help: "port (default: random, recorded in ~/.thurview/server.json)" },
    },
    examples: ["thurview serve", "thurview serve --port 4900"],
  },
  stop: {
    description: "Stop the background review server",
    flags: {},
    examples: ["thurview stop"],
  },
  wait: {
    description:
      "Block until the reader needs the agent: a question, a submitted review, a decision, a close or dismissal",
    flags: {
      review: { kind: "string", help: "review id prefix" },
      timeout: {
        kind: "string",
        help: "seconds before returning reason timeout; keep it under your shell tool's own limit",
        default: "3600",
      },
    },
    examples: ["thurview wait", "thurview wait --review <id> --timeout 600"],
  },
  threads: {
    description: "Read, answer and resolve reviewer threads",
    args: "list|get <id>|reply <id> --body <text>|resolve <id>",
    flags: {
      review: { kind: "string", help: "review id prefix" },
      open: { kind: "boolean", help: "list: only open threads" },
      body: { kind: "string", help: "reply: the answer text" },
      full: { kind: "boolean", help: "get: do not truncate message bodies" },
    },
    examples: [
      "thurview threads list --open",
      "thurview threads get <threadId>",
      'thurview threads reply <threadId> --body "<answer>"',
      "thurview threads resolve <threadId>",
    ],
  },
  graph: {
    description:
      "Ask the code graph at the pinned commits: the interface delta, what the change reaches, callers, tests, architecture",
    args: "interfaces|impact|callers <name>|tests-for <name>|architecture",
    flags: {
      review: { kind: "string", help: "review id prefix" },
      graph: { kind: "string", help: "callers, tests-for: head or base", default: "head" },
      depth: { kind: "string", help: "how many caller hops to follow", default: "2" },
    },
    examples: [
      "thurview graph interfaces",
      "thurview graph impact",
      "thurview graph callers login",
      "thurview graph tests-for login --graph base",
      "thurview graph architecture",
    ],
  },
  delete: {
    description: "Delete a review and everything stored for it (the code is untouched)",
    flags: { review: { kind: "string", help: "review id prefix (required)" } },
    examples: ["thurview delete --review <id>"],
  },
  setup: {
    description: "Install session hooks (ambient context) and the agent skill",
    args: "hooks|skill|status",
    flags: {
      scope: { kind: "string", help: "hooks: user or project", default: "user" },
      remove: { kind: "boolean", help: "hooks: uninstall instead" },
      targets: {
        kind: "string",
        help: "skill: comma list of claude,agents,cursor",
        default: "claude,agents",
      },
    },
    examples: [
      "thurview setup hooks",
      "thurview setup hooks --scope project",
      "thurview setup skill",
      "thurview setup status",
    ],
  },
  skill: {
    description: "Print the path of the bundled skill",
    flags: {},
    examples: ["thurview skill"],
  },
};

function spec(name: string) {
  return SPECS[name]!;
}

async function homeView(): Promise<Out> {
  const worktree = await worktreeOf(process.cwd());
  if (!worktree)
    return {
      reviews: "0 (not inside a git repository)",
      help: [
        "Run `thurview info --all` to list every review",
        "Run `thurview scaffold` inside a git worktree to start one",
      ],
    };
  const mine = (await reviewsFor(worktree)).filter((r) => !r.dismissed);
  if (!mine.length)
    return {
      reviews: `0 reviews bound to ${worktree}`,
      help: [
        "Run `thurview scaffold` to create a review of the current branch",
        "Run `thurview scaffold --pr <number>` for a pull request",
        "Run `thurview explain [<path>]` to explain the codebase at HEAD instead",
      ],
    };
  const reviews = [];
  for (const r of mine) reviews.push(await reviewRow(r, new Set()));
  const help = [
    "Run `thurview info --fields all` for pins and sync state",
    "Run `thurview threads list --open --review <id>` to read reader threads",
    "Run `thurview open --review <id>` to open the browser",
  ];
  if (mine.some((r) => r.status === "draft"))
    help.unshift("Run `thurview publish --review <id>` once review.md and data.yaml are written");
  if (mine.some((r) => r.status === "awaiting-review"))
    help.unshift("Run `thurview wait --review <id>` to block until the reader responds");
  return { reviews, help };
}

const commands: Record<string, (args: string[]) => Promise<Out>> = {
  async scaffold(args) {
    const p = parseFlags("scaffold", args, spec("scaffold").flags);
    const cwd = process.cwd();
    const worktree = await worktreeOf(cwd);
    if (!worktree)
      throw new AxiError("not inside a git repository", "VALIDATION_ERROR", [
        "Run `thurview scaffold` inside the source worktree",
      ]);
    const existing =
      bool(p, "update") || str(p, "review") ? await resolveReview(str(p, "review")) : null;
    let binding: Binding;
    let base: string;
    let head: string;
    let title = str(p, "title") ?? "";
    const b = existing?.binding;
    const pr = str(p, "pr");
    if (pr || b?.kind === "pr") {
      const ref = pr ?? b!.name;
      let info: {
        number: number;
        title: string;
        url: string;
        baseRefName: string;
        headRefOid: string;
      };
      try {
        const { stdout } = await execFileP(
          "gh",
          ["pr", "view", ref, "--json", "number,title,url,baseRefName,headRefOid"],
          { cwd: worktree },
        );
        info = JSON.parse(stdout);
      } catch (e) {
        throw new AxiError(
          `could not read pull request ${ref}: ${(e as Error).message.split("\n")[0]}`,
          "PR_ERROR",
          [
            "Check `gh auth status` and the PR number",
            "Or run `thurview scaffold --base <ref> --head <ref>`",
          ],
        );
      }
      await g
        .fetch(
          worktree,
          "origin",
          `refs/pull/${info.number}/head`,
          `refs/heads/${info.baseRefName}`,
        )
        .catch(() => {});
      head = info.headRefOid;
      let baseRef = `origin/${info.baseRefName}`;
      try {
        await g.revParse(worktree, baseRef);
      } catch {
        baseRef = info.baseRefName;
      }
      base = await g.mergeBase(worktree, baseRef, head);
      binding = { kind: "pr", name: String(info.number), url: info.url };
      title ||= info.title;
    } else if (str(p, "base") || str(p, "head") || b?.kind === "range") {
      const [bb, hh] =
        b?.kind === "range" && !str(p, "base") && !str(p, "head")
          ? b.name.split("..")
          : [str(p, "base"), str(p, "head")];
      try {
        head = await g.revParse(worktree, hh ?? "HEAD");
        base = bb
          ? await g.revParse(worktree, bb)
          : await g.mergeBase(worktree, await g.trunkRef(worktree), head);
      } catch (e) {
        throw new AxiError((e as Error).message, "VALIDATION_ERROR", [
          "Pass resolvable refs: `thurview scaffold --base <ref> --head <ref>`",
        ]);
      }
      binding = { kind: "range", name: `${base.slice(0, 12)}..${head.slice(0, 12)}` };
    } else {
      const branch = b?.kind === "branch" ? b.name : await g.currentBranch(worktree);
      if (!branch)
        throw new AxiError("detached HEAD", "VALIDATION_ERROR", [
          "Run `thurview scaffold --head <ref>` or `--base <ref> --head <ref>`",
        ]);
      await g.fetch(worktree).catch(() => note("note: git fetch failed, using local refs"));
      head = await g.revParse(worktree, branch);
      let trunk: string;
      try {
        trunk = await g.trunkRef(worktree);
      } catch (e) {
        throw new AxiError((e as Error).message, "VALIDATION_ERROR", [
          "Run `thurview scaffold --base <ref> --head <ref>`",
        ]);
      }
      base = await g.mergeBase(worktree, trunk, head);
      binding = { kind: "branch", name: branch };
      title ||= branch;
      if (base === head)
        note(
          `note: ${branch} has no commits past ${trunk}; this is an architecture review of ${head.slice(0, 12)}`,
        );
    }
    let review: ReviewState;
    let reused = false;
    if (existing) {
      review = existing;
      review.pins = { base, head };
      review.binding = binding;
      if (str(p, "title")) review.title = str(p, "title")!;
      await writeReview(review);
    } else {
      const match = bool(p, "new")
        ? []
        : (await reviewsFor(worktree)).filter(
            (r) =>
              r.binding.kind === binding.kind &&
              r.binding.name === binding.name &&
              r.status !== "accepted" &&
              r.status !== "closed",
          );
      if (match.length) {
        review = match[0]!;
        reused = true;
        review.pins = { base, head };
        await writeReview(review);
      } else {
        const id = newId();
        review = {
          schema: SCHEMA,
          id,
          title: title || "Review",
          worktree,
          repoRoot: worktree,
          binding,
          pins: { base, head },
          status: "draft",
          revision: 0,
          dismissed: false,
          createdAt: now(),
          updatedAt: now(),
        };
        await mkdir(reviewDir(id), { recursive: true });
        await writeText(join(reviewDir(id), "review.md"), TEMPLATE_MD(review.title));
        await writeText(join(reviewDir(id), "data.yaml"), TEMPLATE_DATA);
        await writeText(join(reviewDir(id), "map.yaml"), TEMPLATE_MAP);
        await writeText(join(reviewDir(id), "theme.yaml"), TEMPLATE_THEME);
        await writeReview(review);
      }
    }
    const stat = await g.shortStat(worktree, base, head);
    const dir = reviewDir(review.id);
    return {
      review: {
        id: short(review.id),
        uuid: review.id,
        title: review.title,
        status: review.status,
        rev: review.revision,
        binding: binding.kind === "pr" ? `PR #${binding.name}` : binding.name,
        base,
        head,
        worktree,
        reused,
        dir,
      },
      files: {
        document: join(dir, "review.md"),
        data: join(dir, "data.yaml"),
        map: join(dir, "map.yaml"),
        theme: join(dir, "theme.yaml"),
      },
      change: stat,
      guidance: await guidanceFiles(worktree),
      help: [
        `Edit ${join(dir, "review.md")} and data.yaml, then run \`thurview publish --review ${short(review.id)}\``,
        `Run \`thurview graph impact --review ${short(review.id)}\` to see what the change reaches`,
        stat.additions + stat.deletions < 300
          ? `Small change: run \`thurview publish --review ${short(review.id)} --view files --open\` now, then write the document`
          : `Run \`git diff ${base.slice(0, 12)} ${head.slice(0, 12)}\` in ${worktree} to study the change`,
      ],
    };
  },

  async explain(args) {
    const p = parseFlags("explain", args, spec("explain").flags, 1);
    const cwd = process.cwd();
    const worktree = await worktreeOf(cwd);
    if (!worktree)
      throw new AxiError("not inside a git repository", "VALIDATION_ERROR", [
        "Run `thurview explain` inside the source worktree",
      ]);
    const existing =
      bool(p, "update") || str(p, "review") ? await resolveReview(str(p, "review")) : null;
    if (existing && kindOf(existing) !== "explainer")
      throw new AxiError(
        `${short(existing.id)} is a review, not an explainer`,
        "VALIDATION_ERROR",
        [
          "Run `thurview scaffold --update --review <id>` to re-pin a review",
          "Run `thurview explain` with no --review to start an explainer",
        ],
      );
    const scope = scopeGlob(p.positional[0] ?? existing?.binding.name);
    let commit: string;
    try {
      commit = await g.revParse(worktree, str(p, "commit") ?? "HEAD");
    } catch (e) {
      throw new AxiError((e as Error).message, "VALIDATION_ERROR", [
        "Pass a resolvable ref: `thurview explain --commit <ref>`",
      ]);
    }
    // A scope that matches nothing is a typo, and an explainer of nothing would
    // still publish and still state honest-looking coverage of zero files.
    const files = await g.listFiles(worktree, commit);
    const inScope = scope === "**" ? files : files.filter((f) => globToRegExp(scope).test(f));
    if (!inScope.length)
      throw new AxiError(
        `no file matches "${scope}" at ${commit.slice(0, 12)}`,
        "VALIDATION_ERROR",
        [
          "Pass a path that exists at that commit: `thurview explain src/server`",
          "Run `thurview explain` with no scope for the whole repository",
        ],
      );
    const binding: Binding = { kind: "codebase", name: scope };
    const defaultTitle =
      scope === "**" ? worktree.split("/").pop() || "Codebase" : scope.replace(/\/\*\*$/, "");
    let review: ReviewState;
    let reused = false;
    if (existing) {
      review = existing;
      review.pins = { base: commit, head: commit };
      review.binding = binding;
      if (str(p, "title")) review.title = str(p, "title")!;
      await writeReview(review);
    } else {
      const match = bool(p, "new")
        ? []
        : (await reviewsFor(worktree)).filter(
            (r) =>
              kindOf(r) === "explainer" &&
              r.binding.name === scope &&
              r.status !== "accepted" &&
              r.status !== "closed",
          );
      if (match.length) {
        review = match[0]!;
        reused = true;
        review.pins = { base: commit, head: commit };
        await writeReview(review);
      } else {
        const id = newId();
        review = {
          schema: SCHEMA,
          id,
          kind: "explainer",
          title: str(p, "title") || defaultTitle,
          worktree,
          repoRoot: worktree,
          binding,
          pins: { base: commit, head: commit },
          status: "draft",
          revision: 0,
          dismissed: false,
          createdAt: now(),
          updatedAt: now(),
        };
        await mkdir(reviewDir(id), { recursive: true });
        await writeText(join(reviewDir(id), "review.md"), TEMPLATE_EXPLAIN_MD(review.title));
        await writeText(join(reviewDir(id), "data.yaml"), TEMPLATE_EXPLAIN_DATA);
        await writeText(join(reviewDir(id), "map.yaml"), TEMPLATE_EXPLAIN_MAP);
        await writeText(join(reviewDir(id), "theme.yaml"), TEMPLATE_THEME);
        await writeReview(review);
      }
    }
    const dir = reviewDir(review.id);
    return {
      explainer: {
        id: short(review.id),
        uuid: review.id,
        kind: "explainer",
        title: review.title,
        status: review.status,
        rev: review.revision,
        scope,
        commit,
        worktree,
        reused,
        dir,
      },
      files: {
        document: join(dir, "review.md"),
        data: join(dir, "data.yaml"),
        map: join(dir, "map.yaml"),
        theme: join(dir, "theme.yaml"),
      },
      scale: { filesInScope: inScope.length },
      guidance: await guidanceFiles(worktree),
      help: [
        `Run \`thurview graph architecture --review ${short(review.id)}\` for the clusters, their hubs and the links between them`,
        `Author ${join(dir, "map.yaml")} first: it carries the breadth the prose cannot`,
        `Edit ${join(dir, "review.md")} and data.yaml, then run \`thurview publish --review ${short(review.id)}\``,
      ],
    };
  },

  async info(args) {
    const p = parseFlags("info", args, spec("info").flags);
    const fields = new Set((str(p, "fields") ?? "").split(",").filter(Boolean));
    const worktree = await worktreeOf(process.cwd());
    if (!bool(p, "all") && !worktree)
      throw new AxiError("not inside a git repository", "VALIDATION_ERROR", [
        "Run `thurview info --all`",
      ]);
    const list = bool(p, "all") || !worktree ? await listReviews() : await reviewsFor(worktree);
    if (!list.length)
      return {
        reviews: bool(p, "all") ? "0 reviews stored" : `0 reviews bound to ${worktree}`,
        help: ["Run `thurview scaffold` to create one"],
      };
    const reviews = [];
    for (const r of list) reviews.push(await reviewRow(r, fields));
    return {
      count: reviews.length,
      reviews,
      help: [
        "Run `thurview threads list --review <id>` for reader threads",
        "Run `thurview open --review <id>` to open the browser",
      ],
    };
  },

  async publish(args) {
    const p = parseFlags("publish", args, spec("publish").flags);
    const review = await resolveReview(str(p, "review"));
    if (review.status === "accepted" || review.status === "closed")
      throw new AxiError(`review is ${review.status} and cannot be republished`, "TERMINAL", [
        "Run `thurview scaffold --new` for another review of the same change",
      ]);
    const dir = reviewDir(review.id);
    const [reviewMd, dataYaml, mapYaml, themeYaml] = await Promise.all([
      readText(join(dir, "review.md")),
      readText(join(dir, "data.yaml")),
      readText(join(dir, "map.yaml")),
      readText(join(dir, "theme.yaml")),
    ]);
    if (reviewMd === null)
      throw new AxiError("review.md is missing", "VALIDATION_ERROR", [
        `Write ${join(dir, "review.md")}`,
      ]);
    const threads = await readThreads(review.id);
    if (review.revision > 0) {
      const openC = threads.threads.filter(
        (t) => t.kind === "comment" && t.submitted && t.status === "open",
      );
      if (openC.length) {
        throw new AxiError(
          `${openC.length} open comment thread${openC.length > 1 ? "s" : ""} block${openC.length > 1 ? "" : "s"} republish: ${openC.map((t) => t.id).join(", ")}`,
          "THREADS_OPEN",
          [
            `Run \`thurview threads list --open --review ${short(review.id)}\``,
            `Run \`thurview threads resolve <threadId> --review ${short(review.id)}\` after addressing each`,
          ],
        );
      }
    }
    const diags: Diagnostic[] = [];
    let theme: CompiledTheme | null = null;
    if (themeYaml) {
      const t = parseTheme(themeYaml);
      diags.push(...t.diagnostics);
      if (t.theme) {
        theme = compileTheme(
          t.theme,
          (p) => `/api/reviews/${review.id}/blob?path=${encodeURIComponent(p)}`,
        );
        for (const f of t.theme.fonts.files)
          if (!(await g.fileExists(review.worktree, review.pins.head, f.path)))
            diags.push({
              level: "error",
              file: "theme.yaml",
              message: `fonts.files: ${f.path} does not exist at the pinned head commit`,
            });
      }
    }
    const themeName = theme ? await registerTheme(theme.shiki) : undefined;
    const kind = kindOf(review);
    // An explainer has one pinned commit, so there is no delta to derive: the
    // panel above its document states coverage instead.
    let interfaces: InterfaceDelta | null = null;
    if (kind === "review") {
      try {
        interfaces = await deltaFor(review);
      } catch (e) {
        diags.push({
          level: "warning",
          file: "review.md",
          message: `the interface delta is unavailable: ${(e as Error).message}`,
        });
      }
    }
    const doc = await compileDocument({
      cwd: review.worktree,
      pins: review.pins,
      reviewMd,
      dataYaml: dataYaml ?? "",
      kind,
      ...(themeName ? { themeName } : {}),
      interfaces,
    });
    diags.push(...doc.diagnostics);
    let map = null;
    if (mapYaml && /^\s*nodes:\s*(?!\[\s*\])\S/m.test(mapYaml)) {
      const m = await compileMap({
        cwd: review.worktree,
        pins: review.pins,
        mapYaml,
        anchors: doc.anchors,
        kind,
      });
      diags.push(...m.diagnostics);
      map = m.map;
    }
    const rows = diags.map((d) => ({
      level: d.level,
      file: d.file,
      line: d.line ?? "",
      message: d.message,
    }));
    const errors = rows.filter((d) => d.level === "error").length;
    if (!doc.document || errors) {
      process.exitCode = 1;
      return {
        error: `publish failed: ${errors} error${errors > 1 ? "s" : ""}, ${rows.length - errors} warning${rows.length - errors === 1 ? "" : "s"}`,
        code: "PUBLISH_FAILED",
        diagnostics: rows,
        help: [
          `Fix each error in ${dir} and run \`thurview publish --review ${short(review.id)}\` again`,
        ],
      };
    }
    // Coverage is derived, not claimed: every file in scope at the pinned commit
    // is accounted for, so the reader is told what the prose never reached.
    let coverage: Coverage | null = null;
    if (kind === "explainer") {
      try {
        const graph = await import("./graph.js");
        const g0 = await graph.graphAt(review.worktree, review.pins.head, dir);
        coverage = computeCoverage({
          commit: review.pins.head,
          scope: review.binding.name,
          allFiles: await g.listFiles(review.worktree, review.pins.head),
          graph: g0,
          anchored: Object.values(doc.document.anchors)
            .map((a) => a.peek?.file)
            .filter((f): f is string => !!f),
          owners: (map?.head.nodes ?? [])
            .filter((n) => n.files?.length)
            .map((n) => ({ node: n.id, globs: n.files! })),
        });
      } catch (e) {
        diags.push({
          level: "error",
          file: "review.md",
          message: `coverage is unavailable, so the explainer cannot state what it skipped: ${(e as Error).message}`,
        });
        process.exitCode = 1;
        return {
          error: "publish failed: coverage could not be derived",
          code: "PUBLISH_FAILED",
          diagnostics: diags.map((d) => ({
            level: d.level,
            file: d.file,
            line: d.line ?? "",
            message: d.message,
          })),
          help: [`Run \`thurview publish --review ${short(review.id)}\` again`],
        };
      }
    }
    const warnings: string[] = [];
    if (kind === "explainer" && !map)
      warnings.push(
        "this explainer has no map, so every file it does not anchor counts as not examined; author map.yaml to place the rest",
      );
    if (review.binding.kind === "codebase") {
      const tip = await g.revParse(review.worktree, "HEAD").catch(() => null);
      if (tip && tip !== review.pins.head)
        warnings.push(
          `HEAD has moved past the pinned commit; run \`thurview explain --update --review ${short(review.id)}\` to re-pin`,
        );
    }
    if (review.binding.kind === "branch") {
      const tip = await g.revParse(review.worktree, review.binding.name).catch(() => null);
      if (tip && tip !== review.pins.head)
        warnings.push(
          `branch ${review.binding.name} moved past the pinned head; run \`thurview scaffold --update --review ${short(review.id)}\` to re-pin`,
        );
    }
    const n = review.revision + 1;
    const rdir = revisionDir(review.id, n);
    await mkdir(rdir, { recursive: true });
    await cp(join(dir, "review.md"), join(rdir, "review.md"));
    if (dataYaml !== null) await cp(join(dir, "data.yaml"), join(rdir, "data.yaml"));
    if (mapYaml !== null) await cp(join(dir, "map.yaml"), join(rdir, "map.yaml"));
    const changes = await g.changedFiles(review.worktree, review.pins.base, review.pins.head);
    await writeJson(join(rdir, "document.json"), doc.document);
    await writeJson(join(rdir, "map.json"), map);
    await writeJson(join(rdir, "changes.json"), changes);
    await writeJson(join(rdir, "coverage.json"), coverage);
    if (themeYaml !== null) await cp(join(dir, "theme.yaml"), join(rdir, "theme.yaml"));
    await writeJson(join(rdir, "theme.json"), theme);
    await writeJson(join(rdir, "meta.json"), {
      revision: n,
      at: now(),
      title: doc.document.title,
      pins: review.pins,
      kind,
      hasMap: !!map,
      theme: theme?.name ?? "default",
    });
    review.title = doc.document.title;
    review.revision = n;
    review.status = "awaiting-review";
    review.dismissed = false;
    await writeReview(review);
    let st = await serverAlive();
    let url: string | null = null;
    if (bool(p, "open")) st = await ensureServer();
    if (st)
      url = reviewUrl(
        publicUrl(st.port, st.hosts, await tailscaleDns()),
        review.id,
        str(p, "view"),
      );
    if (bool(p, "open") && url) await open(url).catch(() => {});
    const out: Out = {
      published: {
        id: short(review.id),
        kind,
        rev: n,
        title: review.title,
        status: review.status,
        map: !!map,
        ...(kind === "explainer"
          ? { coverage: coverage ? coverage.verdict : "(unavailable)" }
          : { interfaces: doc.document.interfaces?.verdict ?? "(unavailable)" }),
        theme: theme?.name ?? "default",
        url: url ?? "(server not running)",
      },
    };
    if (coverage)
      out["notExamined"] = {
        files: coverage.states.uncovered,
        first: coverage.uncovered.slice(0, 8),
        byPart: coverage.clusters
          .filter((c) => c.uncovered.length)
          .map((c) => ({ part: c.label, files: c.uncovered.length })),
      };
    if (rows.length) out["diagnostics"] = rows;
    if (warnings.length) out["warnings"] = warnings;
    out["help"] = [
      url
        ? `Give the reader ${url}`
        : `Run \`thurview open --review ${short(review.id)}\` to start the server and get the url`,
      `Run \`thurview wait --review ${short(review.id)}\` to block until the reader responds`,
    ];
    return out;
  },

  async open(args) {
    const p = parseFlags("open", args, spec("open").flags);
    const review = await resolveReview(str(p, "review"));
    const s = await ensureServer();
    const url = reviewUrl(
      publicUrl(s.port, s.hosts, await tailscaleDns()),
      review.id,
      str(p, "view"),
    );
    const launch = p.flags["browser"] !== false;
    if (launch) await open(url).catch(() => {});
    return {
      opened: {
        id: short(review.id),
        url,
        local: reviewUrl(`http://127.0.0.1:${s.port}`, review.id, str(p, "view")),
        browser: launch,
      },
      help: [
        `Run \`thurview wait --review ${short(review.id)}\` to block until the reader responds`,
      ],
    };
  },

  async serve(args) {
    const p = parseFlags("serve", args, spec("serve").flags);
    const port = str(p, "port");
    const s = await startServer(port ? { port: Number(port) } : {});
    note(`thurview server on ${s.hosts.map((h) => `http://${h}:${s.port}`).join("  ")}`);
    await new Promise(() => {});
    return {};
  },

  async stop(args) {
    parseFlags("stop", args, {});
    const st = await readJson<{ pid: number }>(serverStateFile());
    if (!st) return { server: "not running (no-op)" };
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      await rm(serverStateFile(), { force: true });
      return { server: "not running (stale state removed, no-op)" };
    }
    await rm(serverStateFile(), { force: true });
    return { server: `stopped pid ${st.pid}` };
  },

  async wait(args) {
    const p = parseFlags("wait", args, spec("wait").flags);
    const review = await resolveReview(str(p, "review"));
    const seconds = Number(str(p, "timeout"));
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new AxiError("--timeout must be a positive number of seconds", "VALIDATION_ERROR", [
        "thurview wait --timeout 600",
      ]);
    const deadline = Date.now() + seconds * 1000;
    const id = short(review.id);
    // While this loop runs the reader is told an agent is listening, and told
    // the opposite the moment it stops.
    const listening = attach(review.id);
    const rows = (ts: Thread[]) =>
      ts.map((t) => ({
        id: t.id,
        kind: t.kind,
        target: targetLabel(t.target),
        last: lastMessage(t),
      }));
    try {
      while (Date.now() < deadline) {
        const r = await readReview(review.id);
        if (!r)
          return {
            wait: { reason: "review-deleted", id },
            help: ["Stop the loop; the review no longer exists"],
          };
        const t = await readThreads(review.id);
        const last = t.decisions[t.decisions.length - 1];
        if (r.status === "awaiting-agent-updates") {
          const need = t.threads.filter(needsAgent);
          return {
            wait: {
              reason: "awaiting-agent-updates",
              id,
              status: r.status,
              decision: last
                ? `${last.decision}${last.body ? `: ${truncate(last.body, 300)}` : ""}`
                : "",
            },
            count: need.length,
            threads: rows(need),
            help: [
              `Run \`thurview threads get <threadId> --review ${id}\` for the full thread`,
              `Run \`thurview threads resolve <threadId> --review ${id}\` after addressing each`,
              `Run \`thurview publish --review ${id}\` when every open comment is resolved`,
            ],
          };
        }
        if (r.status === "accepted" || r.status === "closed")
          return {
            wait: {
              reason: r.status,
              id,
              status: r.status,
              decision: last
                ? `${last.decision}${last.body ? `: ${truncate(last.body, 300)}` : ""}`
                : "",
            },
            help: ["The review is complete; report it and stop the loop"],
          };
        if (r.dismissed)
          return {
            wait: { reason: "review-dismissed", id, status: r.status },
            help: ["Stop the loop; the reader dismissed the review"],
          };
        const asks = t.threads.filter((x) => needsAgent(x) && x.mode === "ask");
        if (asks.length)
          return {
            wait: { reason: "question", id, status: r.status },
            count: asks.length,
            threads: rows(asks),
            help: [
              `Run \`thurview threads reply <threadId> --review ${id} --body "<answer>"\``,
              `Run \`thurview wait --review ${id}\` again afterwards`,
            ],
          };
        await new Promise((res) => setTimeout(res, 700));
      }
      return {
        wait: { reason: "timeout", id, status: review.status, seconds },
        help: [
          `Run \`thurview wait --review ${id}\` again, or report that the reader has not responded`,
        ],
      };
    } finally {
      await listening.stop();
    }
  },

  async graph(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const s = spec("graph").flags;
    const help = [
      "thurview graph interfaces",
      "thurview graph impact",
      "thurview graph callers <name> [--graph base]",
      "thurview graph tests-for <name> [--graph base]",
      "thurview graph architecture",
    ];
    if (!sub || !["interfaces", "impact", "callers", "tests-for", "architecture"].includes(sub))
      throw new AxiError(`unknown graph command${sub ? ` ${sub}` : ""}`, "VALIDATION_ERROR", help);
    const named = sub === "callers" || sub === "tests-for";
    const p = parseFlags(`graph ${sub}`, rest, s, named ? 1 : 0);
    const name = p.positional[0];
    if (named && !name)
      throw new AxiError(`graph ${sub} needs a symbol name`, "VALIDATION_ERROR", help);
    const depth = Number(str(p, "depth") ?? "2");
    if (!Number.isInteger(depth) || depth < 1)
      throw new AxiError("--depth must be a positive integer", "VALIDATION_ERROR", help);
    const side = str(p, "graph") ?? "head";
    if (side !== "head" && side !== "base")
      throw new AxiError("--graph must be head or base", "VALIDATION_ERROR", help);
    const graph = await import("./graph.js");
    const review = await resolveReview(str(p, "review"));
    if (kindOf(review) === "explainer" && (sub === "interfaces" || sub === "impact"))
      throw new AxiError(
        `graph ${sub} compares two commits; an explainer is pinned to one`,
        "VALIDATION_ERROR",
        [
          `Run \`thurview graph architecture --review ${short(review.id)}\` for the structure at that commit`,
          `Run \`thurview graph callers <name> --review ${short(review.id)}\` to follow one symbol`,
        ],
      );
    const dir = reviewDir(review.id);
    const at = (commit: string) => graph.graphAt(review.worktree, commit, dir);
    if (sub === "callers" || sub === "tests-for") {
      const g = await at(side === "base" ? review.pins.base : review.pins.head);
      const pins = {
        graph: side,
        commit: short(g.commit),
        languages: graph.LANGUAGES.join(","),
        truncated: g.truncated,
      };
      if (sub === "callers")
        return {
          ...pins,
          symbol: name,
          callers: graph.callers(g, name!),
          help: [`Run \`thurview graph tests-for ${name}\` to see what exercises it`],
        };
      return {
        ...pins,
        symbol: name,
        depth,
        tests: graph.testsFor(g, name!, depth),
        help: [`Run \`thurview graph callers ${name}\` for every reference`],
      };
    }
    const base = await at(review.pins.base);
    const head = await at(review.pins.head);
    const pins = {
      base: short(base.commit),
      head: short(head.commit),
      languages: graph.LANGUAGES.join(","),
    };
    if (sub === "interfaces") {
      const delta = await deltaFor(review, base, head);
      return {
        ...pins,
        verdict: delta.verdict,
        interfaces: delta.entries.map((e) => ({
          id: e.id,
          change: e.change,
          name: e.name,
          was: e.was,
          kind: e.kind,
          file: e.file,
          line: e.line,
          graph: e.graph,
        })),
        internal: delta.internal,
        unreadable: delta.unreadable,
        truncated: delta.truncated,
        help: [
          "Write one capability line per entry in data.yaml under `interfaces`, keyed by id",
          "Run `thurview graph callers <name>` to see who a removed or changed interface reached",
        ],
      };
    }
    if (sub === "impact") {
      const changes = await g.lineChanges(review.worktree, review.pins.base, review.pins.head);
      return {
        ...pins,
        depth,
        ...graph.impact(base, head, changes, depth),
        help: [
          "Run `thurview graph callers <name>` to follow one symbol",
          "Run `thurview graph architecture` for the module structure and its diff",
        ],
      };
    }
    // An explainer is scoped to a path, so its structure is that path's, not the
    // repository's: the same bound the Coverage tab accounts for.
    if (kindOf(review) === "explainer") {
      const scope = review.binding.name;
      const g0 = scopeGraph(head, scope);
      const allFiles = await g.listFiles(review.worktree, review.pins.head);
      const { diff: _diff, truncated: _truncated, ...rest } = graph.architecture(g0, g0);
      return {
        commit: short(head.commit),
        scope,
        languages: pins.languages,
        truncated: scopeTruncated(allFiles, head, scope),
        ...rest,
        help: [
          "Seed map.yaml nodes from communities, their `files` from a community's files, and edges from edges",
          "A file in no community is outside the languages the graph reads; `thurview publish` counts those",
        ],
      };
    }
    return {
      ...pins,
      ...graph.architecture(base, head),
      help: ["Seed map.yaml nodes from communities and edges from diff.added"],
    };
  },

  async threads(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const s = spec("threads").flags;
    const help = [
      "thurview threads list [--open]",
      "thurview threads get <threadId>",
      'thurview threads reply <threadId> --body "<text>"',
      "thurview threads resolve <threadId>",
    ];
    if (!sub || !["list", "get", "reply", "resolve"].includes(sub))
      throw new AxiError(
        `unknown threads command${sub ? ` ${sub}` : ""}`,
        "VALIDATION_ERROR",
        help,
      );
    if (sub === "list") {
      const p = parseFlags("threads list", rest, { review: s["review"]!, open: s["open"]! });
      const review = await resolveReview(str(p, "review"));
      const t = await readThreads(review.id);
      const list = t.threads.filter((x) => !bool(p, "open") || x.status === "open");
      const id = short(review.id);
      if (!list.length)
        return {
          threads: `0 ${bool(p, "open") ? "open " : ""}threads on review ${id}`,
          decisions: t.decisions.map(
            (d) => `${d.decision} rev ${d.revision}${d.body ? `: ${truncate(d.body, 200)}` : ""}`,
          ),
        };
      return {
        count: `${list.length} of ${t.threads.length} total, ${t.threads.filter(needsAgent).length} need the agent`,
        threads: list.map((x) => ({
          id: x.id,
          kind: x.kind,
          status: x.status,
          needsAgent: needsAgent(x),
          target: targetLabel(x.target),
          last: lastMessage(x),
        })),
        decisions: t.decisions.map(
          (d) => `${d.decision} rev ${d.revision}${d.body ? `: ${truncate(d.body, 200)}` : ""}`,
        ),
        help: [
          `Run \`thurview threads get <threadId> --review ${id}\` for the full thread`,
          `Run \`thurview threads reply <threadId> --review ${id} --body "<text>"\``,
        ],
      };
    }
    const p = parseFlags(
      `threads ${sub}`,
      rest,
      sub === "reply"
        ? { review: s["review"]!, body: s["body"]! }
        : sub === "get"
          ? { review: s["review"]!, full: s["full"]! }
          : { review: s["review"]! },
      1,
    );
    const threadId = p.positional[0];
    if (!threadId)
      throw new AxiError(`threads ${sub} needs a thread id`, "VALIDATION_ERROR", [
        `thurview threads ${sub} <threadId>`,
        "Run `thurview threads list` to see ids",
      ]);
    const review = await resolveReview(str(p, "review"));
    const id = short(review.id);
    if (sub === "get") {
      const th = (await readThreads(review.id)).threads.find((x) => x.id === threadId);
      if (!th)
        throw new AxiError(`thread ${threadId} not found`, "NOT_FOUND", [
          `Run \`thurview threads list --review ${id}\``,
        ]);
      const full = bool(p, "full");
      const out: Out = {
        thread: {
          id: th.id,
          kind: th.kind,
          mode: th.mode,
          status: th.status,
          submitted: th.submitted,
          needsAgent: needsAgent(th),
          target: targetLabel(th.target),
          rev: th.revision,
        },
        messages: th.messages.map((m) => ({
          role: m.role,
          at: m.at,
          body: full ? m.body : truncate(m.body, 1500),
        })),
      };
      if (!full && th.messages.some((m) => m.body.length > 1500))
        out["help"] = [
          `Run \`thurview threads get ${th.id} --review ${id} --full\` for complete bodies`,
        ];
      return out;
    }
    if (sub === "reply") {
      const body = (str(p, "body") ?? "").trim();
      if (!body)
        throw new AxiError("--body is required", "VALIDATION_ERROR", [
          `thurview threads reply ${threadId} --body "<text>"`,
        ]);
      let th: Thread;
      try {
        th = await replyThread(review.id, threadId, "agent", body);
      } catch {
        throw new AxiError(`thread ${threadId} not found`, "NOT_FOUND", [
          `Run \`thurview threads list --review ${id}\``,
        ]);
      }
      return {
        thread: { id: th.id, status: th.status, messages: th.messages.length },
        help: [
          th.kind === "comment"
            ? `Run \`thurview threads resolve ${th.id} --review ${id}\` once the change is present`
            : `Run \`thurview wait --review ${id}\` to wait for the next question`,
        ],
      };
    }
    const existing = (await readThreads(review.id)).threads.find((x) => x.id === threadId);
    if (!existing)
      throw new AxiError(`thread ${threadId} not found`, "NOT_FOUND", [
        `Run \`thurview threads list --review ${id}\``,
      ]);
    if (existing.status === "resolved") return { thread: `${threadId} already resolved (no-op)` };
    await setThreadStatus(review.id, threadId, "resolved");
    const left = (await readThreads(review.id)).threads.filter(
      (x) => x.kind === "comment" && x.submitted && x.status === "open",
    ).length;
    return {
      thread: `${threadId} resolved`,
      openComments: left,
      help: [
        left
          ? `Run \`thurview threads list --open --review ${id}\` for the ${left} left`
          : `Run \`thurview publish --review ${id}\` to seal the next revision`,
      ],
    };
  },

  async delete(args) {
    const p = parseFlags("delete", args, spec("delete").flags);
    const idOpt = str(p, "review");
    if (!idOpt)
      throw new AxiError("--review is required", "VALIDATION_ERROR", [
        "thurview delete --review <id>",
      ]);
    const review = await resolveReview(idOpt);
    await deleteReview(review.id);
    return { deleted: short(review.id) };
  },

  async setup(args) {
    const sub = args[0];
    const s = spec("setup").flags;
    const usage = [
      "thurview setup hooks [--scope user|project] [--remove]",
      "thurview setup skill [--targets claude,agents,cursor]",
      "thurview setup status",
    ];
    if (!sub || !["hooks", "skill", "status"].includes(sub))
      throw new AxiError(`unknown setup command${sub ? ` ${sub}` : ""}`, "VALIDATION_ERROR", usage);
    const identity = { marker: "thurview", binaryNames: ["thurview"] };
    if (sub === "hooks") {
      const p = parseFlags("setup hooks", args.slice(1), {
        scope: s["scope"]!,
        remove: s["remove"]!,
      });
      const scope = str(p, "scope") === "project" ? "project" : "user";
      if (bool(p, "remove")) {
        await uninstallSessionStartHooks({ ...identity, scope });
        return {
          hooks: `removed at ${scope} scope`,
          help: ["Run `thurview setup status` to confirm"],
        };
      }
      await installSessionStartHooks({ ...identity, scope });
      const st = sessionStartHookStatus({ ...identity, scope });
      return {
        hooks: {
          scope,
          claude: st.claude.installed ? st.claude.path : "not installed",
          codex: st.codex.installed ? st.codex.path : "not installed",
          opencode: st.opencode.installed ? st.opencode.path : "not installed",
        },
        help: [
          "Each new agent session now starts with `thurview` output for its working directory",
          "Run `thurview setup skill` for on-demand guidance too",
        ],
      };
    }
    if (sub === "skill") {
      const p = parseFlags("setup skill", args.slice(1), { targets: s["targets"]! });
      const src = resolve(HERE, "..", "skills", "thurview");
      const dirs: Record<string, string> = {
        claude: join(homedir(), ".claude", "skills"),
        agents: join(homedir(), ".agents", "skills"),
        cursor: join(homedir(), ".cursor", "skills"),
      };
      const installed: Record<string, string> = {};
      for (const t of (str(p, "targets") ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        const d = dirs[t];
        if (!d)
          throw new AxiError(`unknown skill target ${t}`, "VALIDATION_ERROR", [
            "thurview setup skill --targets claude,agents,cursor",
          ]);
        await mkdir(d, { recursive: true });
        const dst = join(d, "thurview");
        try {
          const stt = await lstat(dst);
          if (stt.isSymbolicLink()) await rm(dst);
          else
            throw new AxiError(`${dst} exists and is not a symlink`, "CONFLICT", [
              `Remove ${dst} and run \`thurview setup skill\` again`,
            ]);
        } catch (e) {
          if (e instanceof AxiError) throw e;
        }
        await symlink(src, dst, "dir");
        installed[t] = dst;
      }
      return {
        skill: installed,
        help: [
          "Invoke it as /thurview in Claude Code, or by name in other agents",
          "Run `thurview setup hooks` for ambient context at session start",
        ],
      };
    }
    parseFlags("setup status", args.slice(1), {});
    const st = sessionStartHookStatus({ ...identity, scope: "user" });
    const skill: Record<string, string> = {};
    for (const [t, d] of Object.entries({
      claude: join(homedir(), ".claude", "skills", "thurview"),
      agents: join(homedir(), ".agents", "skills", "thurview"),
    }))
      skill[t] = existsSync(d) ? d : "not installed";
    return {
      hooks: {
        claude: st.claude.installed ? st.claude.path : "not installed",
        codex: st.codex.installed ? st.codex.path : "not installed",
        opencode: st.opencode.installed ? st.opencode.path : "not installed",
      },
      skill,
      help: ["Run `thurview setup hooks` or `thurview setup skill` to install what is missing"],
    };
  },

  async skill(args) {
    parseFlags("skill", args, {});
    return { skill: resolve(HERE, "..", "skills", "thurview", "SKILL.md") };
  },
};

function topLevelHelp(): string {
  const cmds: Record<string, string> = {};
  for (const [k, v] of Object.entries(SPECS))
    cmds[k + (v.args ? ` ${v.args}` : "")] = v.description;
  return (
    encode({
      bin: "thurview",
      description: DESCRIPTION,
      commands: cmds,
      examples: [
        "thurview",
        "thurview scaffold",
        "thurview explain src/server",
        "thurview publish --view files --open",
        "thurview wait",
        'thurview threads reply <threadId> --body "<answer>"',
      ],
      help: ["Run `thurview <command> --help` for that command's flags"],
    }) + "\n"
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: topLevelHelp(),
    home: homeView,
    commands,
    getCommandHelp: (command) => {
      const s = SPECS[command];
      return s ? encode(helpFor(command, s.description, s.flags, s.examples, s.args)) + "\n" : null;
    },
  });
}
