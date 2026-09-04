import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class GitError extends Error {}

export async function git(
  cwd: string,
  args: string[],
  opts?: { maxBuffer?: number },
): Promise<string>;
export async function git(
  cwd: string,
  args: string[],
  opts: { maxBuffer?: number; encoding: "buffer" },
): Promise<Buffer>;
export async function git(
  cwd: string,
  args: string[],
  opts: { maxBuffer?: number; encoding?: "buffer" } = {},
): Promise<string | Buffer> {
  try {
    if (opts.encoding === "buffer") {
      const { stdout } = await execFileP("git", args, {
        cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "buffer",
      });
      return stdout;
    }
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError((e.stderr || e.message).trim());
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const out = (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  if (!/^[0-9a-f]{40}$/.test(out)) throw new GitError(`cannot resolve ${ref}`);
  return out;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  return (await git(cwd, ["merge-base", a, b])).trim();
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return out === "HEAD" ? null : out;
}

/** Trunk ref such as origin/main, or a local main/master when no remote exists. */
export async function trunkRef(cwd: string): Promise<string> {
  try {
    const head = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    return head.replace(/^refs\/remotes\//, "");
  } catch {
    for (const c of ["origin/main", "origin/master", "main", "master"]) {
      try {
        await revParse(cwd, c);
        return c;
      } catch {
        /* next */
      }
    }
    throw new GitError("no trunk found (origin/HEAD, main or master)");
  }
}

export async function fetch(cwd: string, ...args: string[]): Promise<void> {
  await git(cwd, ["fetch", "--quiet", ...args]);
}

export async function showFile(cwd: string, commit: string, path: string): Promise<string | null> {
  try {
    return await git(cwd, ["show", `${commit}:${path}`]);
  } catch {
    return null;
  }
}

export async function fileExists(cwd: string, commit: string, path: string): Promise<boolean> {
  try {
    await git(cwd, ["cat-file", "-e", `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(cwd: string, commit: string): Promise<string[]> {
  const out = await git(cwd, ["ls-tree", "-r", "--name-only", "-z", commit]);
  return out.split("\0").filter(Boolean);
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  additions: number;
  deletions: number;
  binary: boolean;
}

export async function changedFiles(
  cwd: string,
  base: string,
  head: string,
): Promise<ChangedFile[]> {
  const status = await git(cwd, ["diff", "--name-status", "-z", "-M", base, head]);
  const numstat = await git(cwd, ["diff", "--numstat", "-z", "-M", base, head]);
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = numstat.split("\0");
  for (let i = 0; i < parts.length;) {
    const rec = parts[i];
    if (!rec) break;
    const m = /^(\S+)\t(\S+)\t(.*)$/s.exec(rec);
    if (!m) {
      i += 1;
      continue;
    }
    const binary = m[1] === "-";
    let path = m[3] ?? "";
    if (path === "") {
      path = parts[i + 2] ?? "";
      i += 3;
    } else {
      i += 1;
    }
    stats.set(path, {
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  const out: ChangedFile[] = [];
  const s = status.split("\0");
  for (let i = 0; i < s.length;) {
    const code = s[i];
    if (!code) break;
    const kind = code[0] as ChangedFile["status"];
    if (kind === "R" || kind === "C") {
      const oldPath = s[i + 1] ?? "";
      const path = s[i + 2] ?? "";
      const st = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
      out.push({ path, oldPath, status: kind, ...st });
      i += 3;
    } else {
      const path = s[i + 1] ?? "";
      const st = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
      out.push({ path, status: kind, ...st });
      i += 2;
    }
  }
  return out;
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

export async function log(cwd: string, base: string, head: string): Promise<Commit[]> {
  const RS = "\x1e";
  const US = "\x1f";
  const out = await git(cwd, [
    "log",
    "--reverse",
    `--format=%x1e%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI`,
    "--name-only",
    `${base}..${head}`,
  ]);
  const commits: Commit[] = [];
  for (const chunk of out.split(RS).slice(1)) {
    const [meta, ...rest] = chunk.split("\n");
    const f = (meta ?? "").split(US);
    const files = rest.map((l) => l.trim()).filter(Boolean);
    commits.push({
      sha: f[0] ?? "",
      shortSha: f[1] ?? "",
      subject: f[2] ?? "",
      body: (f[3] ?? "").trim(),
      author: f[4] ?? "",
      date: f[5] ?? "",
      files,
    });
  }
  return commits;
}

export async function shortStat(
  cwd: string,
  base: string,
  head: string,
): Promise<{ files: number; additions: number; deletions: number }> {
  const files = await changedFiles(cwd, base, head);
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

export interface LineChange {
  added: Set<number>;
  deleted: Set<number>;
  oldPath?: string;
}

/** Line numbers added (in head) and deleted (in base) per head path, from the pinned diff. */
export async function lineChanges(
  cwd: string,
  base: string,
  head: string,
): Promise<Map<string, LineChange>> {
  const out = await git(cwd, ["diff", "-U0", "-M", "--no-color", base, head]);
  const result = new Map<string, LineChange>();
  let cur: LineChange | null = null;
  let oldPath = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      cur = { added: new Set(), deleted: new Set() };
      if (oldPath !== "/dev/null" && oldPath !== p) cur.oldPath = oldPath;
      result.set(p === "/dev/null" ? oldPath : p, cur);
    } else if (line.startsWith("@@") && cur) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const os = Number(m[1]);
      const oc = m[2] === undefined ? 1 : Number(m[2]);
      const ns = Number(m[3]);
      const nc = m[4] === undefined ? 1 : Number(m[4]);
      for (let i = 0; i < oc; i++) cur.deleted.add(os + i);
      for (let i = 0; i < nc; i++) cur.added.add(ns + i);
    }
  }
  return result;
}
