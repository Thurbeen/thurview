// A publish target belongs to its user, and a personal one must never receive
// a company's code. The thurview-publish skill's scope check reads a
// repository's remotes and holds them to the target's allow and deny globs
// before anything is exported; these drive it over real git repositories.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "skills",
  "thurview-publish",
  "scripts",
  "check-scope.mjs",
);
const made: string[] = [];

/** A repository whose remotes are the given name → url pairs. */
function repo(remotes: Record<string, string>, push: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "thurview-scope-"));
  made.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, url] of Object.entries(remotes))
    execFileSync("git", ["-C", dir, "remote", "add", name, url]);
  for (const [name, url] of Object.entries(push))
    execFileSync("git", ["-C", dir, "remote", "set-url", "--push", name, url]);
  return dir;
}

// An ssh that knows one alias, the way a ~/.ssh/config `Host work-gh` with
// `HostName github.com` answers `ssh -G work-gh`.
const sshBin = mkdtempSync(join(tmpdir(), "thurview-ssh-"));
made.push(sshBin);
writeFileSync(
  join(sshBin, "ssh"),
  '#!/bin/sh\n[ "$1" = -G ] || exit 255\ncase "$2" in work-gh) echo "hostname github.com" ;; *) echo "hostname $2" ;; esac\n',
);
chmodSync(join(sshBin, "ssh"), 0o755);

function check(dir: string, ...scope: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", dir, ...scope], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${sshBin}:${process.env["PATH"]}` },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const WORK = "gitlab.example.com/**";

describe("thurview-publish scope check", () => {
  it("refuses a repository a deny pattern names, and says which remote and pattern", () => {
    const dir = repo({ origin: "git@gitlab.example.com:team/app.git" });
    const { code, out } = check(dir, "--deny", WORK);
    expect(code).toBe(1);
    expect(out).toContain("gitlab.example.com/team/app");
    expect(out).toContain(WORK);
  });

  it("refuses when any remote is denied, not only origin", () => {
    const dir = repo({
      origin: "https://github.com/someone/fork.git",
      upstream: "ssh://git@gitlab.example.com:2222/team/app.git",
    });
    expect(check(dir, "--deny", WORK).code).toBe(1);
  });

  it("refuses when only the push URL is denied", () => {
    const dir = repo(
      { origin: "https://github.com/someone/fork.git" },
      { origin: "git@gitlab.example.com:team/app.git" },
    );
    expect(check(dir, "--deny", WORK).code).toBe(1);
  });

  it("allows a repository no deny pattern names", () => {
    const dir = repo({ origin: "https://github.com/someone/notes.git" });
    expect(check(dir, "--deny", WORK).code).toBe(0);
  });

  it("allows a repository whose every remote an allow pattern names", () => {
    const dir = repo({
      origin: "git@gitlab.example.com:team/app.git",
      mirror: "https://gitlab.example.com/team/app-mirror",
    });
    expect(check(dir, "--allow", WORK).code).toBe(0);
  });

  it("refuses under an allow list when a remote matches none of it", () => {
    expect(
      check(repo({ origin: "https://github.com/someone/notes.git" }), "--allow", WORK).code,
    ).toBe(1);
    const mixed = repo({
      origin: "git@gitlab.example.com:team/app.git",
      personal: "https://github.com/someone/app.git",
    });
    expect(check(mixed, "--allow", WORK).code).toBe(1);
  });

  it("lets a deny win over an allow", () => {
    const dir = repo({ origin: "git@gitlab.example.com:secret/app.git" });
    expect(check(dir, "--allow", WORK, "--deny", "gitlab.example.com/secret/**").code).toBe(1);
  });

  it("matches one path segment with *, any depth with **, and ignores case", () => {
    const dir = repo({ origin: "https://GitHub.com/Someone/group/sub/Repo.git" });
    expect(check(dir, "--allow", "github.com/someone/*").code).toBe(1);
    expect(check(dir, "--allow", "github.com/someone/**").code).toBe(0);
  });

  it("never prints a credential carried in a remote URL", () => {
    const dir = repo({ origin: "https://oauth2:s3cr3t-token@gitlab.example.com/team/app.git" });
    const { code, out } = check(dir, "--deny", WORK);
    expect(code).toBe(1);
    expect(out).not.toContain("s3cr3t-token");
    expect(out).not.toContain("oauth2");
  });

  it("sees through an ssh host alias to the host it names", () => {
    const dir = repo({ origin: "git@work-gh:example-corp/app.git" });
    expect(check(dir, "--deny", "github.com/example-corp/**").code).toBe(1);
    expect(
      check(
        repo({ origin: "ssh://git@work-gh/example-corp/app" }),
        "--deny",
        "github.com/example-corp/**",
      ).code,
    ).toBe(1);
  });

  it.each([
    "git@github.com:/example-corp/app.git",
    "https://github.com:/example-corp/app",
    "https://github.com./example-corp/app",
    "https://github.com//example-corp/app",
    "https://GitHub.com/Example-Corp/App.GIT",
    "https://github.com/example-corp/app?ref=main#top",
    "https://github.com/example-corp/app/.git",
    "https://user:pa#ss@github.com/example-corp/app",
    "https://user:p?ss@github.com/example-corp/app",
  ])("reads %s as github.com/example-corp/app", (url) => {
    expect(check(repo({ origin: url }), "--deny", "github.com/example-corp/app").code).toBe(1);
  });

  it.each([
    "https://a@b:tok3n@github.com/example-corp/app",
    "https://u:p/tok3n@github.com/example-corp/app",
    "https://github.com/example-corp/app?token=tok3n",
    "https://user:tok3n#x@github.com/example-corp/app",
  ])("prints nothing of the credential in %s", (url) => {
    const { out } = check(repo({ origin: url }), "--deny", "github.com/example-corp/**");
    expect(out).not.toContain("tok3n");
  });

  it("keeps an @ in a path as part of the path, as git does", () => {
    const dir = repo({ origin: "https://github.com/example-corp/app@main" });
    expect(check(dir, "--deny", "github.com/example-corp/**").code).toBe(1);
  });

  it("reads a bracketed host in scp syntax", () => {
    const dir = repo({ origin: "git@[2001:db8::1]:example-corp/app.git" });
    expect(check(dir, "--deny", "[2001:db8::1]/example-corp/**").code).toBe(1);
  });

  it("asks the user about a remote that is a local path, which no host glob can judge", () => {
    const local = repo({ origin: "/srv/clones/corp-app" });
    expect(check(local, "--deny", WORK).code).toBe(2);
    expect(check(repo({ origin: "file:///srv/clones/corp-app" }), "--deny", WORK).code).toBe(2);
    // a refusal still wins over a remote nobody can judge
    const both = repo({
      origin: "/srv/clones/corp-app",
      work: "git@gitlab.example.com:team/app.git",
    });
    expect(check(both, "--deny", WORK).code).toBe(1);
  });

  it("asks the user when the target has no scope", () => {
    const { code, out } = check(repo({ origin: "https://github.com/someone/notes.git" }));
    expect(code).toBe(2);
    expect(out).toMatch(/no scope/i);
  });

  it("asks the user when the repository has no remote to judge by", () => {
    expect(check(repo({}), "--deny", WORK).code).toBe(2);
  });

  it("rejects an unknown flag as a usage error", () => {
    expect(check(repo({ origin: "https://github.com/a/b.git" }), "--alow", WORK).code).toBe(64);
  });
});
