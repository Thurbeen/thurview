// The terminal proof of concept, end to end: a design published by thurview
// itself, projected from the sealed revision into the pane's model, then drawn
// and driven three ways - the projection alone, the pane's view in the Lua 5.4
// the host embeds, and the pane installed into an isolated thurbox and driven
// through a real terminal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import {
  htmlToBlocks,
  project,
  toLua,
  type TerminalModel,
} from "../examples/terminal-poc/project.ts";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const POC = join(ROOT, "examples", "terminal-poc");

const onPath = (bin: string) =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((d) => join(d, bin))
    .find((p) => existsSync(p));
const luaBin = onPath("lua5.4");
const thurboxBin = onPath("thurbox");
const tmuxBin = onPath("tmux");

let tmp: string;
let revision: string;
let commit: string;
let model: TerminalModel;
let ui: string;

async function cli(repo: string, home: string, args: string[]) {
  const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const { stdout } = await execFileP(process.execPath, [tsx, join(ROOT, "src/main.ts"), ...args], {
    cwd: repo,
    env: { ...process.env, THURVIEW_HOME: home },
  });
  return decode(stdout.trim()) as Record<string, any>;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "thurview-terminal-poc-"));
  const home = join(tmp, "home");
  const repo = join(tmp, "repo");
  await cp(join(POC, "fixture", "repo"), repo, { recursive: true });
  const git = (...a: string[]) =>
    execFileP("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("add", ".");
  await git("commit", "-q", "-m", "relay");
  commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const { design } = await cli(repo, home, ["design", "--title", "relay"]);
  for (const f of ["review.md", "data.yaml", "map.yaml"])
    await cp(join(POC, "fixture", "doc", f), join(design.dir, f));
  await cli(repo, home, ["publish", "--review", design.id]);
  revision = join(design.dir, "revisions", "1");
  model = await project(revision);
  // The pane's own files, as the install step lays them out, plus the model.
  ui = join(tmp, "ui");
  await cp(join(POC, "ui"), ui, { recursive: true });
  await writeFile(join(ui, "thurview_poc", "model.lua"), toLua(model));
}, 120_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe("projecting a sealed revision into the terminal model", () => {
  it("keeps the document's identity: title, kind, revision and the pinned commit", () => {
    expect(model.title).toBe("relay: fan-out delivery with a dead-letter queue");
    expect(model.kind).toBe("design");
    expect(model.revision).toBe(1);
    expect(model.commit).toBe(commit);
  });

  it("turns the compiled prose into styled runs, with no markup left in the text", () => {
    const headings = model.blocks.filter((b) => b.t === "heading").map((b) => b.text);
    expect(headings).toEqual([
      "relay: fan-out delivery with a dead-letter queue",
      "How a delivery works today",
      "What to build",
      "One event, end to end",
      "Retry or park",
      "Failure handling",
      "Migration",
      "Open questions",
    ]);
    const runs = model.blocks.flatMap((b) => ("runs" in b ? b.runs : []));
    expect(runs.map((r) => r.text).join("")).not.toMatch(/[<>]|&amp;|&#39;/);
    expect(runs).toContainEqual({ text: "one attempt counter", anchor: "tick" });
    expect(runs).toContainEqual({ text: "fan-out router", strong: true });
    expect(runs).toContainEqual({ text: "deliveries", code: true });
    const ordered = model.blocks.filter((b) => b.t === "item" && b.marker === "1.");
    expect(ordered.length).toBeGreaterThan(0);
    const table = model.blocks.find((b) => b.t === "table");
    expect(table && table.t === "table" && table.rows[0]).toEqual(["Part", "Owns", "Today"]);
    expect(table && table.t === "table" && table.rows).toHaveLength(4);
  });

  it("carries every anchor's file, lines and code as plain tokens at the pinned commit", () => {
    const tick = model.anchors["tick"]!;
    expect(tick).toMatchObject({
      file: "src/worker/deliver.ts",
      from: 9,
      to: 25,
      map: "relay.worker",
    });
    expect(tick.lines).toHaveLength(17);
    expect(tick.lines[0]!.map((t) => t.text).join("")).toBe(
      "/** One pass: lease an event, post it to every subscriber, settle the row. */",
    );
    expect(tick.lines[0]![0]!.tok).toBe("comment");
    expect(tick.lines.flat().some((t) => t.tok === "keyword" && t.text === "export")).toBe(true);
  });

  it("keeps the map's proposal: added and changed parts, and labelled connections", () => {
    const node = (id: string) => model.map.nodes.find((n) => n.id === id);
    expect(node("relay.router")).toMatchObject({ label: "Fan-out router", status: "added" });
    expect(node("relay.outbox")).toMatchObject({ status: "changed" });
    expect(node("sender")?.status).toBeUndefined();
    expect(model.map.edges).toContainEqual({
      from: "relay.worker",
      to: "relay.deadletter",
      label: "park after last attempt",
    });
  });

  it("resolves each sequence message to the map nodes its actors stand for", () => {
    const seq = model.blocks.find((b) => b.t === "sequence");
    expect(seq && seq.t === "sequence" && seq.messages[0]).toEqual({
      from: "sender",
      to: "relay.receiver",
      label: "POST /events with an HMAC signature",
      anchor: "receive",
    });
    expect(seq && seq.t === "sequence" && seq.messages).toHaveLength(7);
  });

  it("keeps the text after a nested list inside its own item, not a new bullet", () => {
    const blocks = htmlToBlocks(
      "<ul>\n<li>outer\n<ul>\n<li>inner</li>\n</ul>\nstill outer</li>\n</ul>\n",
    );
    expect(
      blocks.map((b) => (b.t === "item" ? [b.marker, b.depth, b.runs[0]?.text] : b.t)),
    ).toEqual([
      ["•", 0, "outer"],
      ["•", 1, "inner"],
      ["", 0, "still outer"],
    ]);
  });

  it("refuses a directory that is not a sealed revision", async () => {
    await expect(project(tmp)).rejects.toThrow(/not a published revision/);
  });
});

interface Frame {
  rows: string[];
  /** cells drawn in the flow highlight: "row:col:text" */
  flow: string[];
  status: string;
}

/** Drive the pane's view in Lua 5.4 with a script of `size`, `key` and `render` lines. */
function drive(script: string[], modelFile?: string): Frame[] {
  const args = [
    join(ROOT, "test", "terminal-poc-drive.lua"),
    ui,
    ...(modelFile ? [modelFile] : []),
  ];
  const stdout = execFileSync(luaBin!, args, {
    input: script.join("\n") + "\n",
    encoding: "utf8",
  });
  return stdout
    .split("\f\n")
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk) as Frame);
}

const width = (s: string) => [...s].length;
const screen = (f: Frame) => f.rows.join("\n");

describe.skipIf(!luaBin)("the pane's view, in the Lua the host embeds", () => {
  it("draws the document beside the architecture map on a wide pane", async () => {
    const [f] = await drive(["size 120 40", "render 0"]);
    expect(f!.rows).toHaveLength(40);
    expect(f!.rows.every((r) => width(r) <= 120)).toBe(true);
    const s = screen(f!);
    expect(s).toContain("relay: fan-out delivery with a dead-letter queue");
    expect(s).toMatch(/│ *Receiver *│/);
    expect(s).toMatch(/╭/);
    expect(s).toContain("store once");
  });

  it("moves section by section and opens an anchor's code at the pinned commit", async () => {
    const [, section, anchored] = await drive([
      "size 120 40",
      "render 0",
      "key ]",
      "render 0",
      "key n",
      "render 0",
    ]);
    expect(section!.rows.some((r) => r.includes("How a delivery works today"))).toBe(true);
    // `n` takes the first anchor at or below where the reader is, not the first in the document.
    const s = screen(anchored!);
    expect(s).toContain("src/http/receive.ts:10-15");
    expect(s).toContain(`@ ${commit.slice(0, 7)}`);
    expect(s).toContain("export function verify(");
  });

  it("keeps a narrow pane legible: one view at a time, and a map you pan across", async () => {
    const [doc, map, panned] = await drive([
      "size 70 30",
      "render 0",
      "key tab",
      "render 0",
      "key right",
      "key right",
      "key right",
      "key right",
      "render 0",
    ]);
    for (const f of [doc!, map!, panned!]) expect(f.rows.every((r) => width(r) <= 70)).toBe(true);
    expect(screen(doc!)).toContain("relay: fan-out delivery");
    expect(screen(doc!)).not.toMatch(/╭/);
    expect(screen(map!)).toMatch(/╭/);
    expect(screen(panned!)).not.toBe(screen(map!));
    expect(map!.status).toMatch(/pan/);
  });

  it("selects a node and lists its labelled connections", async () => {
    const frames = await drive(["size 120 40", "key tab", "key j", "key j", "key j", "render 0"]);
    const s = screen(frames[0]!);
    expect(s).toMatch(/Receiver/);
    expect(s).toContain("Verifies the HMAC, stores once, answers 202");
    expect(s).toMatch(/→ Outbox +store once/);
    expect(s).toMatch(/← Event sender +POST \/events/);
  });

  it("plays a sequence over the map one message at a time, and pauses", async () => {
    const [first, second, paused, still] = await drive([
      "size 120 40",
      "key space",
      "render 10",
      "render 11.3",
      "key space",
      "render 11.4",
      "render 30",
    ]);
    expect(first!.status).toMatch(/▶ 1\/7/);
    expect(screen(first!)).toContain("POST /events with an HMAC signature");
    expect(first!.flow.length).toBeGreaterThan(0);
    expect(second!.status).toMatch(/▶ 2\/7/);
    expect(screen(second!)).toContain("store the event once");
    expect(second!.flow).not.toEqual(first!.flow);
    expect(paused!.status).toMatch(/⏸ 2\/7/);
    expect(still!.status).toBe(paused!.status);
    expect(still!.flow).toEqual(paused!.flow);
  });

  it("draws a document with no map, and its map keys do nothing rather than fail", async () => {
    const file = join(tmp, "no-map.lua");
    await writeFile(file, toLua({ ...model, map: { nodes: [], edges: [] } }));
    const [f] = drive(["size 120 40", "key tab", "key j", "key k", "key enter", "render 0"], file);
    expect(screen(f!)).toContain("relay: fan-out delivery");
    expect(screen(f!)).toContain("node · none");
  });

  it("stops by itself after one pass, and resumes where it was after being hidden", async () => {
    const frames = await drive([
      "size 120 40",
      "key space",
      "render 10",
      "render 11.3",
      // hidden: nothing rendered for most of a minute
      "render 60",
      "render 61.3",
      ...Array.from({ length: 12 }, (_, i) => `render ${62 + i}`),
    ]);
    expect(frames[2]!.status).toMatch(/▶ 2\/7/);
    expect(frames[3]!.status).toMatch(/▶ 3\/7/);
    expect(frames.at(-1)!.status).toMatch(/⏸ 7\/7/);
  });
});

const sandboxEnv = (root: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("THURBOX_") && !k.startsWith("TMUX")) env[k] = v;
  return {
    ...env,
    HOME: join(root, "home"),
    THURBOX_CONFIG_DIR: join(root, "config"),
    THURBOX_DATA_DIR: join(root, "data"),
    THURBOX_SOCKET: `thurview-poc-${process.pid}`,
    TMUX_TMPDIR: join(root, "tmux"),
    TERM: "xterm-256color",
  };
};

describe.skipIf(!thurboxBin || !tmuxBin || !luaBin)(
  "the pane installed into an isolated thurbox",
  { timeout: 60_000 },
  () => {
    let root: string;
    let env: NodeJS.ProcessEnv;
    const tmux = (...a: string[]) =>
      execFileSync(tmuxBin!, ["-L", "view", "-f", "/dev/null", ...a], { env, encoding: "utf8" });
    const capture = () => tmux("capture-pane", "-p", "-t", "poc");
    const until = async (want: (s: string) => boolean, what: string) => {
      const deadline = Date.now() + 15_000;
      let s = "";
      while (Date.now() < deadline) {
        s = capture();
        if (want(s)) return s;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`the terminal never showed ${what}:\n${s}`);
    };

    beforeAll(async () => {
      root = join(tmp, "thurbox");
      env = sandboxEnv(root);
      for (const d of ["home", "tmux"]) await mkdir(join(root, d), { recursive: true });
      // The first run delivers the shipped interface into the isolated profile.
      tmux("new-session", "-d", "-s", "poc", "-x", "160", "-y", "45", thurboxBin!);
      const uiDir = join(root, "config", "ui");
      await until(() => existsSync(join(uiDir, "layout.lua")), "a delivered interface");
      tmux("kill-server");
      await execFileP(join(POC, "install.sh"), [uiDir, join(ui, "thurview_poc", "model.lua")], {
        env,
      });
      tmux("new-session", "-d", "-s", "poc", "-x", "160", "-y", "45", thurboxBin!);
      await until((s) => s.includes("thurbox"), "the interface");
    }, 60_000);

    afterAll(() => {
      try {
        tmux("kill-server");
      } catch {
        /* already gone */
      }
      try {
        execFileSync(tmuxBin!, ["-L", env["THURBOX_SOCKET"]!, "kill-server"], {
          env,
          stdio: "ignore",
        });
      } catch {
        /* thurbox started no session server */
      }
    });

    it("loads cleanly by the host's own check", async () => {
      const { stdout } = await execFileP("thurbox-cli", ["plugin", "check", "--text"], { env });
      expect(stdout).toMatch(/thurview/);
      const files = await readdir(join(root, "config", "ui", "thurview_poc"));
      expect(files.sort()).toEqual(["diagram.lua", "model.lua", "view.lua"]);
    });

    it("opens on F3 with the document and the map, and answers the pane's keys", async () => {
      tmux("send-keys", "-t", "poc", "F3");
      const opened = await until(
        (s) => s.includes("relay: fan-out delivery") && /│ *Receiver *│/.test(s),
        "the document beside the map",
      );
      expect(opened).toContain("store once");
      tmux("send-keys", "-t", "poc", "n");
      await until((s) => s.includes("src/worker/deliver.ts:18-20"), "the first anchor's peek");
      tmux("send-keys", "-t", "poc", "Space");
      await until((s) => /▶ \d\/7/.test(s), "the flow playing");
      tmux("send-keys", "-t", "poc", "Space");
      await until((s) => /⏸ \d\/7/.test(s), "the flow paused");
      // A key the view does not use falls through: Esc goes back where it came from.
      tmux("send-keys", "-t", "poc", "Escape");
      await until((s) => /^ Agent /m.test(s), "the focus back on the agent pane");
      const text = await readFile(join(root, "config", "ui", "thurview_poc", "model.lua"), "utf8");
      expect(text).toMatch(/^return {/m);
    });
  },
);
