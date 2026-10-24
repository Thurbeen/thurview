/**
 * The declared review scope: which paths of the repository under review a
 * thurview document is allowed to read.
 *
 * Without one, every route that takes a path reads it at a pinned commit and
 * nothing enumerates what is reviewable, so a `.env`, a keystore or a generated
 * blob committed at either pin is served in full to whoever can reach the
 * server. The scope inverts that default: a path is readable only because the
 * repository said so.
 *
 * Three things follow from where the rules live and what they are for.
 *
 * **The rules are an allowlist, not an ignore list.** An ignore list covers the
 * file types someone remembered; an allowlist makes an unexpected file fail by
 * absence. That is the property that does the work, so `extensions` and
 * `filenames` are what a path must match, and `exclude` only narrows further.
 *
 * **`filenames` is a list of its own beside `extensions`,** because thurview is
 * language-agnostic: `Dockerfile`, `Makefile`, `Jenkinsfile` and a dotfile whose
 * entire name is its suffix have no extension to allow.
 *
 * **`exclude` matches from the first segment of the path, never at any segment.**
 * `src/generated` excludes `src/generated/**` and leaves `lib/src/generated/**`
 * alone. Any-segment matching is right for a tool's own list of build output -
 * and wrong for a rule a person wrote,
 * where "any segment named `test`" silently drops a package whose own name ends
 * in `test`. An entry may hold a glob, and it is still anchored at the first
 * segment: `*` is one segment, so a `*` then `test` is the `test` directory of
 * every top-level module, and reaching any depth takes a `**` somebody wrote.
 *
 * The rules are read from the repository under review, at the pinned head
 * commit, which means the change request being reviewed can edit them. That is
 * deliberate and it is visible in the diff, but it bounds what this is: a
 * control against putting the wrong file in front of a reviewer by accident,
 * not a boundary that holds against an author who does not want it to.
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { listFiles, showFile } from "./git.js";

/** Where the rules live, at the root of the repository under review. */
export const SCOPE_FILE = "thurview-scope.yaml";

export class ScopeError extends Error {}

const list = z.array(z.string().min(1)).default([]);

const ScopeSchema = z
  .object({
    /** allowed extensions, with or without the leading dot; matched case-insensitively */
    extensions: list,
    /** allowed whole file names, matched exactly - for the extensionless and the dotfiles */
    filenames: list,
    /** directory paths or globs excluded from the first segment of the path, not at any segment */
    exclude: list,
  })
  .strict()
  .refine((s) => s.extensions.length > 0 || s.filenames.length > 0, {
    message:
      "declare at least one entry under `extensions` or `filenames`: an allowlist that allows nothing hides the whole repository",
  });

export interface ReviewScope {
  /** whether the repository declared rules at all; false means every path is readable, as before */
  declared: boolean;
  extensions: string[];
  filenames: string[];
  exclude: string[];
  /**
   * Cache key for anything derived under this scope. A symbol
   * index built while one set of rules was in force must never answer for
   * another, or a narrowed scope keeps serving the paths it just excluded.
   */
  digest: string;
  inScope(path: string): boolean;
  /** one line naming the rules, for `publish`, `scaffold` and the reader's page */
  verdict: string;
}

/** Nothing declared: every path at the pins is readable, which is thurview's behaviour without a scope file. */
export const OPEN_SCOPE: ReviewScope = {
  declared: false,
  extensions: [],
  filenames: [],
  exclude: [],
  digest: "open",
  inScope: () => true,
  verdict: `no ${SCOPE_FILE} at the pinned head commit: every path is readable`,
};

/**
 * The path as the rules see it, canonical and idempotent. Segment-wise rather
 * than by stripping prefixes: `git show <rev>:<path>` resolves any number of
 * leading `./`, so a matcher that strips one of them answers about a different
 * path than git reads, and `././secrets/key.css` walks past an `exclude` that
 * holds `secrets/key.css` out. `..` is kept, and refused where it is read.
 */
function clean(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

/**
 * The characters that make an `exclude` entry a glob. Exactly the ones the rules
 * refused before globs were read, so every entry a repository could already
 * declare is still a literal path and matches exactly what it matched then.
 */
const GLOB = /[*?[\]]/;

/**
 * One segment of a glob against one segment of a path: `*` is any run of
 * characters and `?` any one, neither crossing a `/` because a segment holds
 * none. Matched with two pointers rather than a regular expression, because the
 * rules come from the change under review, and `*a*a*a*...` in a backtracking
 * regex holds the server's one thread for seconds on a single path.
 */
function segmentMatches(glob: string, seg: string): boolean {
  let g = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < seg.length) {
    if (g < glob.length && (glob[g] === "?" || glob[g] === seg[s])) {
      g++;
      s++;
    } else if (g < glob.length && glob[g] === "*") {
      star = g++;
      mark = s;
    } else if (star >= 0) {
      g = star + 1;
      s = ++mark;
    } else return false;
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}

/** A segment every path segment matches: `**`, or `*`s with at most one `?` beside them. */
function matchesAnySegment(seg: string): boolean {
  return seg === "**" || (/^[*?]+$/.test(seg) && seg.includes("*") && seg.split("?").length <= 2);
}

/**
 * Compile one glob entry to a test on a path's segments. The entry is anchored
 * at the first segment and matches a prefix of the path, exactly as a literal
 * entry does: the path is excluded when its first few segments match every
 * segment of the entry. `*` stays inside one segment; `**`, only as a whole
 * segment, stands for zero or more of them.
 */
export function compileGlob(entry: string): (segments: string[]) => boolean {
  const segs = entry.split("/");
  for (const seg of segs) {
    if (seg.includes("**") && seg !== "**")
      throw new ScopeError(
        `exclude: "${entry}" puts "**" inside a segment, and "**" stands only for whole segments (write "**/test", not "**test")`,
      );
    // A bracket is refused rather than read as a class: `app/[id]` is a route
    // directory in half the web frameworks, and a class would read it as "one
    // `i` or `d`" and leave the real directory open. Refused, it stays the
    // error it was before globs were read.
    if (/[[\]]/.test(seg))
      throw new ScopeError(
        `exclude: "${entry}" holds a bracket, and exclude reads no character classes - exclude the directory's parent, or write "?" for each bracket`,
      );
  }
  const parts = segs.map((seg) => (seg === "**" ? ("**" as const) : seg));
  if (segs.every(matchesAnySegment))
    throw new ScopeError(
      `exclude: "${entry}" matches every path, which excludes the whole repository`,
    );
  return (path) => {
    // Which (entry segment, path segment) pairs were already tried: `**` can
    // reach one pair by several routes, and a path is short but not free.
    const seen = new Set<number>();
    const at = (e: number, p: number): boolean => {
      if (e === parts.length) return true;
      const key = e * (path.length + 1) + p;
      if (seen.has(key)) return false;
      seen.add(key);
      const part = parts[e]!;
      if (part === "**") return at(e + 1, p) || (p < path.length && at(e, p + 1));
      return p < path.length && segmentMatches(part, path[p]!) && at(e + 1, p + 1);
    };
    return at(0, 0);
  };
}

/**
 * The test one `exclude` entry puts to a path, literal or glob alike, for the
 * callers that ask about a single entry rather than the whole scope: `publish`
 * warns about each entry that holds nothing out. Takes the entry as `exclude`
 * holds it, already cleaned and validated by `makeScope`.
 */
export function excludeMatcher(entry: string): (path: string) => boolean {
  if (!GLOB.test(entry)) return (path) => path === entry || path.startsWith(`${entry}/`);
  const glob = compileGlob(entry);
  return (path) => glob(clean(path).split("/"));
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Build a scope from already-parsed rules. Exported so the matcher can be unit
 * tested without a git repository behind it.
 */
export function makeScope(raw: unknown): ReviewScope {
  const parsed = ScopeSchema.safeParse(raw ?? {});
  if (!parsed.success)
    throw new ScopeError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  const extensions = [
    ...new Set(parsed.data.extensions.map((e) => e.replace(/^\./, "").toLowerCase())),
  ].sort();
  // An entry that cannot match anything has to be refused where it is written.
  // These two lists fail closed, so a typo in them hides files rather than
  // exposing them - but it hides them while the verdict claims a rule is in
  // force, and "1 extension" that matches nothing is not a rule.
  for (const e of extensions) {
    if (/[*?[\]/]/.test(e))
      throw new ScopeError(
        `extensions: "${e}" is a glob or a path, and extensions takes a bare suffix (write "ts", not "*.ts")`,
      );
    if (e.includes("."))
      throw new ScopeError(
        `extensions: "${e}" holds a dot, and only the last suffix of a name is matched (write "gz", not "tar.gz")`,
      );
  }
  const filenames = [...new Set(parsed.data.filenames)].sort();
  for (const f of filenames)
    if (f.includes("/"))
      throw new ScopeError(
        `filenames: "${f}" is a path, and filenames matches a whole file name anywhere in the tree (write "Dockerfile", not "src/Dockerfile")`,
      );
  // A glob with an empty segment is refused before `clean` would quietly fold
  // it away: `*//test` is a typo for something, and guessing which one is how a
  // rule comes to exclude less than its author meant.
  for (const e of parsed.data.exclude)
    if (GLOB.test(e) && /[^/]\/\/+[^/]/.test(e))
      throw new ScopeError(`exclude: "${e}" holds an empty segment between two "/"`);
  const exclude = [...new Set(parsed.data.exclude.map(clean))].sort();
  for (const e of exclude) {
    if (!e) throw new ScopeError("exclude: an empty path excludes the whole repository");
    if (e.split("/").includes("..")) throw new ScopeError(`exclude: "${e}" leaves the repository`);
  }
  const excluders = exclude.map(excludeMatcher);
  const digest = createHash("sha256")
    .update(JSON.stringify({ extensions, filenames, exclude }))
    .digest("hex")
    .slice(0, 12);
  const inScope = (path: string): boolean => {
    const p = clean(path);
    if (!p) return false;
    // A path that climbs out of the repository is nothing the rules can allow.
    // `git show` refuses these itself, so this is the belt to that braces.
    if (p.split("/").includes("..")) return false;
    // The rules themselves are always readable. A reviewer told a file was
    // withheld has to be able to read the rule that withheld it, and that rule
    // is part of the change request under review.
    if (p === SCOPE_FILE) return true;
    if (excluders.some((x) => x(p))) return false;
    const name = p.split("/").pop() ?? p;
    if (filenames.includes(name)) return true;
    const ext = extensionOf(p);
    return ext !== "" && extensions.includes(ext);
  };
  const parts = [
    extensions.length
      ? `${extensions.length} extension${extensions.length === 1 ? "" : "s"}`
      : null,
    filenames.length ? `${filenames.length} file name${filenames.length === 1 ? "" : "s"}` : null,
    exclude.length
      ? `${exclude.length} excluded director${exclude.length === 1 ? "y" : "ies"}`
      : null,
  ].filter(Boolean);
  return {
    declared: true,
    extensions,
    filenames,
    exclude,
    digest,
    inScope,
    verdict: `${SCOPE_FILE} allows ${parts.join(", ")}; every other path is withheld`,
  };
}

/**
 * Whether a changed file may be shown at all. A rename is readable only when
 * both of its sides are: the diff's "before" is the content of `oldPath`, so a
 * `git mv secrets/token.ts src/token.ts` under `exclude: [secrets]` would list
 * an allowed path whose diff is an excluded file. Withhold the whole change and
 * count it as withheld, which is what `/diff` already answers for it.
 */
export function changeInScope(scope: ReviewScope, c: { path: string; oldPath?: string }): boolean {
  return scope.inScope(c.path) && (!c.oldPath || scope.inScope(c.oldPath));
}

/** The rules a published revision was sealed under, as `meta.json` records them. */
export interface SealedRules {
  declared: boolean;
  extensions: string[];
  filenames: string[];
  exclude: string[];
}

/**
 * Whether every path `sealed` allowed is still allowed now. A revision holds only
 * what the rules in force when it was published let in, so when the rules since
 * widened there is nothing in it the rules in force would withhold, and refusing
 * it would cost the reader the history for nothing. Narrowing is the case the
 * refusal exists for, and it stays refused.
 */
export function allowsEverything(now: ReviewScope, sealed: SealedRules): boolean {
  // A revision sealed with no rules declared holds whatever the repository had,
  // so only an equally open scope can be trusted to serve it.
  if (!sealed.declared) return !now.declared;
  if (!now.declared) return true;
  const covers = (mine: string[], theirs: string[]) => theirs.every((x) => mine.includes(x));
  if (!covers(now.extensions, sealed.extensions)) return false;
  if (!covers(now.filenames, sealed.filenames)) return false;
  // Every directory excluded now must already have been excluded then, or this
  // scope withholds something the revision was allowed to seal. Compared as
  // text, globs included: an entry that extends a sealed one by whole segments
  // matches only paths the sealed one already held out, whatever either holds.
  // A glob that covers a literal (`*/test` sealed, `app/test` now) is not
  // recognised, and that errs toward refusing the revision, never toward
  // serving it.
  return now.exclude.every((dir) =>
    sealed.exclude.some((s) => dir === s || dir.startsWith(`${s}/`)),
  );
}

const cache = new Map<string, ReviewScope | ScopeError>();

/**
 * The scope declared at `commit` in the repository at `cwd`. Read from git
 * rather than from the working tree, so the rules are the ones the reviewed
 * commit carries and cannot drift under the reader while a branch is checked
 * out beneath a running server.
 *
 * A file that is present but malformed throws rather than falling back to an
 * open scope: a scope that is declared and silently not applied is worse than
 * none, because it reads as an assurance.
 */
export async function scopeAt(cwd: string, commit: string): Promise<ReviewScope> {
  const key = `${cwd}@${commit}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit instanceof ScopeError) throw hit;
    return hit;
  }
  const text = await showFile(cwd, commit, SCOPE_FILE);
  let value: ReviewScope | ScopeError;
  if (text === null) {
    // `showFile` answers null for "no such path" and for any git failure alike,
    // and the second must not read as "this repository declared nothing": in a
    // partial clone missing exactly this blob that would open the whole tree.
    // A removed checkout cannot yield file content; keep its sealed document readable.
    // An intact tree with a missing rules blob must still declare its scope.
    value =
      existsSync(cwd) && (await listFiles(cwd, commit)).includes(SCOPE_FILE)
        ? new ScopeError(
            `${SCOPE_FILE} exists at ${commit.slice(0, 8)} but git would not read it; refusing to review as if no rules were declared`,
          )
        : OPEN_SCOPE;
  } else {
    try {
      value = makeScope(parseYaml(text) ?? {});
    } catch (e) {
      value =
        e instanceof ScopeError
          ? e
          : new ScopeError(`${SCOPE_FILE} is not valid YAML: ${(e as Error).message}`);
    }
  }
  cache.set(key, value);
  if (value instanceof ScopeError) throw value;
  return value;
}
