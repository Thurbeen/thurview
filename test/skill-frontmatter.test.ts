import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git"]);

function skillFiles(): string[] {
  return readdirSync(repoRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === "SKILL.md")
    .map((e) => `${e.parentPath.slice(repoRoot.length)}/${e.name}`)
    .filter((p) => !p.split("/").some((seg) => SKIP.has(seg)));
}

/** Every markdown file the skills tree ships, SKILL.md and references alike. */
function skillMarkdown(): string[] {
  return readdirSync(`${repoRoot}skills`, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `${e.parentPath.slice(repoRoot.length)}/${e.name}`)
    .filter((p) => !p.split("/").some((seg) => SKIP.has(seg)));
}

/**
 * Load a SKILL.md frontmatter the way a skill installer does: the leading
 * `---` block, parsed as YAML. Throws when it is missing or does not parse.
 */
function loadFrontmatter(source: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!m) throw new Error("no frontmatter block");
  const fm = parseYaml(m[1]!) as unknown;
  if (!fm || typeof fm !== "object" || Array.isArray(fm))
    throw new Error("frontmatter is not a mapping");
  return fm as Record<string, unknown>;
}

describe("SKILL.md frontmatter", () => {
  const files = skillFiles();

  it("finds the skills to check", () => {
    expect(files).toContain("skills/thurview/SKILL.md");
  });

  it("ships one review skill, the one that fixes what it finds", () => {
    expect(files).toContain("skills/thurview-fix/SKILL.md");
    expect(files).not.toContain("skills/forge-review/SKILL.md");
    expect(files).not.toContain("skills/review-fix/SKILL.md");
  });

  // A skill name is what the agent resolves and what the reader types, so it
  // has to say which product it belongs to; `review-fix` did not.
  it("names every skill after the product it belongs to", () => {
    for (const path of files) expect(path).toMatch(/^skills\/thurview(-[a-z-]+)?\/SKILL\.md$/);
  });

  it.each(files)("%s parses as YAML and names the skill", (path) => {
    const fm = loadFrontmatter(readFileSync(`${repoRoot}${path}`, "utf8"));
    expect(typeof fm["name"]).toBe("string");
    expect(typeof fm["description"]).toBe("string");
  });

  it.each(files)("%s is named after its folder and its links resolve", (path) => {
    const source = readFileSync(`${repoRoot}${path}`, "utf8");
    const dir = path.slice(0, path.lastIndexOf("/"));
    expect(loadFrontmatter(source)["name"]).toBe(dir.slice(dir.lastIndexOf("/") + 1));
    for (const [, target] of source.matchAll(/\]\((references\/[^)]+)\)/g))
      expect(existsSync(`${repoRoot}${dir}/${target}`), `${path} links to ${target}`).toBe(true);
  });

  // The explainer used to be a second kind inside the review skill, and a
  // description offering two kinds makes the agent decide twice: once on the
  // skill, once on the body. One kind, one skill, one description to match on.
  it("ships the explainer as its own skill and stops advertising it in thurview", () => {
    expect(files).toContain("skills/thurview-explain/SKILL.md");
    const explain = loadFrontmatter(
      readFileSync(`${repoRoot}skills/thurview-explain/SKILL.md`, "utf8"),
    );
    const description = String(explain["description"]);
    expect(description).toMatch(/explain/i);
    expect(description).toMatch(/codebase/i);
    expect(description).toMatch(/not for reviewing a change/i);

    const thurview = readFileSync(`${repoRoot}skills/thurview/SKILL.md`, "utf8");
    const reviewDescription = String(loadFrontmatter(thurview)["description"]);
    expect(reviewDescription).toMatch(/review of a branch/);
    expect(reviewDescription).not.toMatch(/code explainer/);
    // Routing matches on the description, so thurview's own must send a
    // codebase request on rather than let it be corrected once the body is read.
    expect(reviewDescription).toContain("thurview-explain");
  });

  // How to write an explainer has one home, and a second copy is the drift
  // this split exists to remove. A text check cannot catch a reworded copy,
  // so this is a tripwire on the two sections that carry the kind's rules
  // rather than a proof of no duplication: it fires when either is pasted
  // into another skill file, under whatever filename, and it fires again if
  // one is renamed here - in which case update the strings and say why.
  it.each(["## Coverage is derived, not claimed", "## Surface structure; do not grade it"])(
    "keeps the explainer section `%s` in one file only",
    (heading) => {
      const homes = skillMarkdown().filter((path) =>
        readFileSync(`${repoRoot}${path}`, "utf8").includes(heading),
      );
      expect(homes).toEqual(["skills/thurview-explain/SKILL.md"]);
    },
  );

  // A third kind with no skill beside it is a CLI command nobody reaches for,
  // and one whose description does not say "not a review" is a skill that
  // triggers on the wrong request.
  it("ships the design skill and keeps it apart from the review one", () => {
    expect(files).toContain("skills/thurview-design/SKILL.md");
    const fm = loadFrontmatter(readFileSync(`${repoRoot}skills/thurview-design/SKILL.md`, "utf8"));
    const description = String(fm["description"]);
    expect(description).toMatch(/design/);
    expect(description).toMatch(/implementation plan/);
    expect(description).toMatch(/not for reviewing a change/i);
    // Routing matches on the description, so thurview's own must redirect a
    // design request rather than leave it to be corrected once the body is read.
    const thurview = readFileSync(`${repoRoot}skills/thurview/SKILL.md`, "utf8");
    expect(thurview).toContain("thurview-design");
    expect(String(loadFrontmatter(thurview)["description"])).toContain("thurview-design");
  });

  it("rejects the unquoted `key: value` that broke the installer", () => {
    // The exact shape shipped on main: `Two kinds: ` inside an unquoted
    // scalar reads as a nested mapping, which no installer will load.
    const broken = [
      "---",
      "name: thurview",
      "description: A thing. Two kinds: a review, and an explainer.",
      "---",
      "",
    ].join("\n");
    expect(() => loadFrontmatter(broken)).toThrow(/mapping/);
  });
});
