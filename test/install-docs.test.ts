import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// Every `skills add` command in a document's sh blocks, with `\` continuations
// joined, so a command split over lines is checked as one.
async function installCommands(file: string): Promise<string[]> {
  const text = await readFile(join(ROOT, file), "utf8");
  const blocks = [...text.matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
  return blocks
    .flatMap((b) => b.replace(/\\\n\s*/g, " ").split("\n"))
    .filter((line) => /\bskills(@\S+)? add\b/.test(line));
}

describe("install docs", () => {
  it("installs the skills as one universal copy symlinked into another agent", async () => {
    const readme = await installCommands("README.md");
    const install = await installCommands("docs/INSTALL.md");
    expect(readme.length).toBeGreaterThan(0);
    expect(install.length).toBeGreaterThan(0);
    const commands = [...readme, ...install];
    for (const command of commands) {
      expect(command).toMatch(/^npx skills@latest add /);
      // With --yes and a single agent the CLI copies instead of linking, so
      // universal must be named alongside at least one more agent.
      expect(command).toMatch(/--agent universal [a-z][\w-]*/);
      expect(command).toContain("--global");
      expect(command).toContain("--yes");
      expect(command).not.toContain("--copy");
    }
  });
});
