import { describe, it, expect, beforeAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// thurview is a review tool: the explainer and design kinds are gone, and a
// record or a command left over from them is refused by name, not misread.

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const REVIEW_SKILLS = ["thurview", "thurview-fix", "thurview-pr-review", "thurview-publish"];

let repo: string;
let home: string;

type Out = Record<string, any>;
async function cli(args: string[], expectCode = 0): Promise<Out> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "main.ts"), ...args],
      { cwd: repo, env: { ...process.env, THURVIEW_HOME: home } },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      if (code !== expectCode)
        return reject(new Error(`thurview ${args.join(" ")} exited ${code}\n${out}`));
      resolve(decode(out.trim()) as Out);
    });
  });
}

const git = (...a: string[]) =>
  execFileP("git", a, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

/** A record an older thurview wrote for a kind this one no longer has. */
async function leftover(kind: string): Promise<string> {
  const id = randomUUID();
  const { stdout } = await git("rev-parse", "HEAD");
  const head = stdout.trim();
  await mkdir(join(home, "reviews", id), { recursive: true });
  const at = new Date().toISOString();
  await writeFile(
    join(home, "reviews", id, "review.json"),
    JSON.stringify({
      schema: 1,
      id,
      kind,
      title: `old ${kind}`,
      worktree: repo,
      repoRoot: repo,
      binding: { kind: "codebase", name: "**" },
      pins: { base: head, head },
      status: "draft",
      revision: 0,
      dismissed: false,
      createdAt: at,
      updatedAt: at,
    }),
  );
  return id;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "thurview-home-"));
  repo = await mkdtemp(join(tmpdir(), "thurview-repo-"));
  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "auth.ts"), "export function login(user: string) {\n  return !!user;\n}\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  await git("checkout", "-q", "-b", "feature");
  await writeFile(
    join(repo, "auth.ts"),
    "export function login(user: string) {\n  return user.trim().length > 0;\n}\n",
  );
  await git("commit", "-qam", "reject a blank user");
}, 30_000);

describe("thurview is a review tool only", () => {
  it("bundles and packages the review skills and nothing else", async () => {
    const out = await cli(["skill"]);
    expect(Object.keys(out["skills"]).sort()).toEqual(REVIEW_SKILLS);
    const { stdout } = await execFileP("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
    });
    const packed = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map(
      (f) => f.path,
    );
    const skills = new Set(
      packed.filter((f) => f.startsWith("skills/")).map((f) => f.split("/")[1]),
    );
    expect([...skills].sort()).toEqual(REVIEW_SKILLS);
  }, 60_000);

  it("describes itself, and every skill, as review only", async () => {
    const help = await cli(["--help"]);
    expect(String(help["description"])).not.toMatch(/explainer|design/i);
    expect(Object.keys(help["commands"]).join(" ")).not.toMatch(/\b(explain|design)\b/);
    for (const name of await readdir(join(ROOT, "skills"))) {
      const skill = await readFile(join(ROOT, "skills", name, "SKILL.md"), "utf8");
      expect(skill, name).not.toMatch(/thurview-(explain|design)|\bexplainer\b|software map/i);
    }
  });

  it.each(["explain", "design"])("refuses `thurview %s` and points at a review", async (cmd) => {
    const out = await cli([cmd, "src"], 2);
    expect(out["code"]).toBe("VALIDATION_ERROR");
    expect(out["error"]).toMatch(/removed/);
    expect(String(out["help"])).toContain("thurview scaffold");
  });

  it.each(["explainer", "design"])(
    "refuses a stored %s by name, and still deletes it",
    async (kind) => {
      const id = await leftover(kind);
      const out = await cli(["publish", "--review", id], 2);
      expect(out["error"]).toMatch(new RegExp(`${kind}.*no longer`));
      expect(String(out["help"])).toContain(`thurview delete --review ${id.slice(0, 8)}`);
      await cli(["delete", "--review", id]);
      expect(existsSync(join(home, "reviews", id))).toBe(false);
    },
  );

  it("still scaffolds, seals and exports a review end to end", async () => {
    const r = (await cli(["scaffold"]))["review"];
    await writeFile(
      join(r.dir, "review.md"),
      "# Reject a blank user\n\n**Summary**\n\n- [`login` now trims](anchor:blank) before it checks.\n",
    );
    await writeFile(
      join(r.dir, "data.yaml"),
      "architecture: { view: Fits the design. }\nanchors:\n  blank:\n    title: the trimmed check\n    peek: { file: auth.ts, from: 1, to: 3 }\n",
    );
    const out = await cli(["publish", "--review", r.uuid]);
    expect(out["published"].rev).toBe(1);
    expect(out["diagnostics"]).toBeUndefined();
    const file = join(home, "page.html");
    await cli(["export", r.uuid, "--out", file]);
    expect(await readFile(file, "utf8")).toContain("Reject a blank user");
  }, 30_000);
});
