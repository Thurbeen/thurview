#!/usr/bin/env node
// Is this repository's code allowed on this publish target?
//
//   node check-scope.mjs --repo <dir> [--allow <glob>]... [--deny <glob>]...
//
// Every fetch and push URL of every remote is reduced to host/path - no
// scheme, user, password, port or .git - and matched against the globs, where
// `*` stays inside one path segment and `**` crosses them, ignoring case.
// A deny match on any URL refuses; with an allow list, so does any URL that
// matches none of it. An ssh alias is also judged by the host `ssh -G` says
// it names. Exit 0 allowed, 1 refused, 2 nothing to decide by (no scope, no
// remote, not a repository, a local-path remote) so the user must be asked,
// 64 misuse.
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

/**
 * Where a remote URL points, as git reads it: a URL with a scheme, the scp
 * form when a `:` comes before any `/`, or else a local path. Lowercased, with
 * the user, password, port, query, fragment, `.git` and stray slashes gone.
 */
function parseRemote(url) {
  const u = url.trim().toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(u);
  const scp = /^(?:[^/]*@)?(\[[^\]/]*\]|[^/:[\]]+):(.*)$/.exec(u);
  let host;
  let path;
  let ssh = true;
  if (scheme) {
    if (scheme[1] === "file") return { local: true, where: tidy(scheme[2] + scheme[3]) };
    const authority = scheme[2].slice(scheme[2].lastIndexOf("@") + 1);
    host = /^(\[[^\]]*\]|[^:]*)/.exec(authority)[1];
    path = scheme[3];
    ssh = scheme[1].includes("ssh");
  } else if (scp) [, host, path] = scp;
  else return { local: true, where: tidy(u) };
  return {
    local: false,
    host: host.replace(/[?#].*$/, "").replace(/\.$/, ""),
    path: tidy(path),
    ssh,
  };
}

function tidy(path) {
  return path
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** The host an ssh alias stands for, as `ssh -G` resolves it without connecting. */
function sshHostname(alias) {
  try {
    const out = execFileSync("ssh", ["-G", alias], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return /^hostname (.+)$/m.exec(out)?.[1]?.trim().toLowerCase().replace(/\.$/, "") ?? alias;
  } catch {
    return alias;
  }
}

/** Every host/path a remote URL can be judged by: an ssh alias and what it names. */
function forms(url) {
  const r = parseRemote(url);
  if (r.local) return { local: true, names: [r.where] };
  const names = [`${r.host}/${r.path}`];
  const real = r.ssh ? sshHostname(r.host) : r.host;
  if (real !== r.host) names.push(`${real}/${r.path}`);
  return { local: false, names };
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
    ]) {
      const f = forms(url);
      urls.set(`${name} ${f.names.join(" ")}`, { name, ...f });
    }
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
let unjudged = false;
for (const { name, names, local } of remotes) {
  // a malformed URL can leave a password fragment in the path; never print it
  const masked = names.map((n) => n.replace(/[^/]*@/g, "…@"));
  const shown = masked.length > 1 ? `${masked[0]} (${masked[1]})` : masked[0];
  const denied = deny.find(([, re]) => names.some((n) => re.test(n)));
  const allowed = allow.length === 0 || allow.some(([, re]) => names.some((n) => re.test(n)));
  if (denied) console.log(`refused: ${name} ${shown} matches deny_remotes ${denied[0]}`);
  else if (local)
    console.log(`unjudged: ${name} ${shown} is a local path, not a host - ask the user`);
  else if (!allowed) console.log(`refused: ${name} ${shown} matches no allow_remotes pattern`);
  else console.log(`allowed: ${name} ${shown}`);
  refused ||= Boolean(denied) || (!local && !allowed);
  unjudged ||= local && !denied;
}
process.exit(refused ? 1 : unjudged ? 2 : 0);
