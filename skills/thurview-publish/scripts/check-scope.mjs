#!/usr/bin/env node
// Is this repository's code allowed on this publish target?
//
//   node check-scope.mjs --repo <dir> [--allow <glob>]... [--deny <glob>]...
//
// Every fetch and push URL of every remote is reduced to host/path - no
// scheme, user, password, port or .git - and matched against the globs, where
// `*` stays inside one path segment and `**` crosses them, ignoring case.
// A deny match on any URL refuses; with an allow list, so does any URL that
// matches none of it. Exit 0 allowed, 1 refused, 2 nothing to decide by (no
// scope, no remote, not a repository) so the user must be asked, 64 misuse.
import { execFileSync } from "node:child_process";

const USAGE = "usage: check-scope.mjs --repo <dir> [--allow <glob>]... [--deny <glob>]...";

function parse(argv) {
  const opts = { repo: ".", allow: [], deny: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined || !["--repo", "--allow", "--deny"].includes(flag)) {
      console.error(`unknown or incomplete flag: ${flag}\n${USAGE}`);
      process.exit(64);
    }
    if (flag === "--repo") opts.repo = value;
    else opts[flag.slice(2)].push(value);
  }
  return opts;
}

/** host/path of a remote URL, with nothing that could carry a credential. */
function normalize(url) {
  let host = "";
  let path = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]*)(?::\d+)?\/?(.*)$/i.exec(url);
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/.exec(url);
  if (scheme) [, host, path] = scheme;
  else if (scp) [, host, path] = scp;
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  return (host ? `${host}/${path}` : path).toLowerCase();
}

function globToRegExp(glob) {
  const body = glob
    .toLowerCase()
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${body}$`);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function remoteUrls(repo) {
  const urls = new Map();
  for (const name of git(repo, "remote"))
    for (const url of [
      ...git(repo, "remote", "get-url", "--all", name),
      ...git(repo, "remote", "get-url", "--push", "--all", name),
    ])
      urls.set(`${name} ${normalize(url)}`, { name, where: normalize(url) });
  return [...urls.values()];
}

const opts = parse(process.argv.slice(2));
if (opts.allow.length === 0 && opts.deny.length === 0) {
  console.log("no scope: this target names no allow_remotes or deny_remotes - ask the user");
  process.exit(2);
}
let remotes;
try {
  remotes = remoteUrls(opts.repo);
} catch {
  console.log(`not a git repository: ${opts.repo} - ask the user`);
  process.exit(2);
}
if (remotes.length === 0) {
  console.log("no remote to judge this repository by - ask the user");
  process.exit(2);
}

const deny = opts.deny.map((g) => [g, globToRegExp(g)]);
const allow = opts.allow.map((g) => [g, globToRegExp(g)]);
let refused = false;
for (const { name, where } of remotes) {
  const denied = deny.find(([, re]) => re.test(where));
  const allowed = allow.length === 0 || allow.some(([, re]) => re.test(where));
  if (denied) console.log(`refused: ${name} ${where} matches deny_remotes ${denied[0]}`);
  else if (!allowed) console.log(`refused: ${name} ${where} matches no allow_remotes pattern`);
  else console.log(`allowed: ${name} ${where}`);
  refused ||= Boolean(denied) || !allowed;
}
process.exit(refused ? 1 : 0);
