// The terminal proof of concept, end to end: a design published by thurview
// itself, projected from the sealed revision into the pane's model, then drawn
// and driven three ways - the projection alone, the pane's view in the Lua 5.4
// the host embeds, and the pane installed into an isolated thurbox and driven
// through a real terminal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
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
let home: string;
let repo: string;
let reviewId: string;

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
  home = join(tmp, "home");
  repo = join(tmp, "repo");
  // The bridge imports thurview's built modules, so build them from this checkout.
  await execFileP(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: ROOT,
  });
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
  reviewId = design.uuid;
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

  it("carries what a write needs: the review, its store, and each block's id", async () => {
    expect(model.review).toBe(reviewId);
    expect(model.home).toBe(home);
    const doc = JSON.parse(await readFile(join(revision, "document.json"), "utf8"));
    const heading = doc.blocks.find(
      (b: any) => b.type === "heading" && b.text === "Failure handling",
    );
    const html = doc.blocks.find(
      (b: any) => b.type === "html" && b.html.includes("A slow subscriber"),
    );
    const blockOf = (pred: (b: any) => boolean) => model.blocks.find(pred);
    expect(blockOf((b) => b.t === "heading" && b.text === "Failure handling")?.bid).toBe(
      heading.id,
    );
    expect(
      blockOf(
        (b) => b.t === "item" && b.runs.some((r: any) => r.text.includes("A slow subscriber")),
      )?.bid,
    ).toBe(html.id);
    expect(model.blocks.every((b) => typeof b.bid === "string")).toBe(true);
  });

  it("refuses a directory that is not a sealed revision", async () => {
    await expect(project(tmp)).rejects.toThrow(/not a published revision/);
  });
});

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const bridge = (...args: string[]) =>
  execFileP(process.execPath, [join(POC, "bridge.mjs"), ...args], {
    env: { ...process.env, THURVIEW_HOME: home },
  });
const bidOf = (text: string) =>
  model.blocks.find((b) => b.t === "heading" && b.text === text)!.bid!;

describe("writing comments and reviews through thurview's own threads module", () => {
  it("holds a review comment until the review is submitted, as the browser does", async () => {
    const created = await bridge(
      "create",
      reviewId,
      "document",
      hex(bidOf("Migration")),
      "review",
      hex("Drain first?"),
    );
    expect(created.stdout).toMatch(/^T\t\w+\tcomment\treview\topen\t0\tdocument\t/m);
    expect(created.stdout).toContain(`M\treviewer\t${hex("Drain first?")}`);
    // Held: listed, but not yet something the agent is asked to answer.
    const drain = (list: Record<string, any>) =>
      (list["threads"] as { last: string; needsAgent: boolean }[]).find((t) =>
        t.last.includes("Drain first?"),
      );
    expect(
      drain(await cli(repo, home, ["threads", "list", "--review", reviewId]))?.needsAgent,
    ).toBe(false);
    const submitted = await bridge("submit", reviewId, "request-changes", hex("see the migration"));
    expect(submitted.stdout).toMatch(/^R\tawaiting-agent-updates\t/m);
    expect(submitted.stdout).toMatch(/^D\trequest-changes\t1\t/m);
    expect(
      drain(await cli(repo, home, ["threads", "list", "--review", reviewId]))?.needsAgent,
    ).toBe(true);
  });

  it("asks a question at once, shows the agent's answer, and resolves it", async () => {
    const asked = await bridge(
      "create",
      reviewId,
      "map",
      hex("relay.outbox"),
      "ask",
      hex("Why one table?"),
    );
    const id = /^T\t(\w+)\tquestion\task\topen\t1\tmap\t/m.exec(asked.stdout)?.[1];
    expect(id).toBeTruthy();
    await cli(repo, home, ["threads", "reply", id!, "--review", reviewId, "--body", "One writer."]);
    const listed = await bridge("list", reviewId);
    expect(listed.stdout).toContain(`M\tagent\t${hex("One writer.")}`);
    const resolved = await bridge("status", reviewId, id!, "resolved");
    expect(resolved.stdout).toMatch(new RegExp(`^T\\t${id}\\tquestion\\task\\tresolved\\t`, "m"));
    const replied = await bridge("reply", reviewId, id!, hex("Thanks"));
    expect(replied.stdout).toMatch(new RegExp(`^T\\t${id}\\tquestion\\task\\topen\\t`, "m"));
  });

  it("refuses what thurview would refuse, with the reason on stdout and exit 1", async () => {
    const bad = await bridge("create", reviewId, "document", hex("x"), "later", hex("?")).catch(
      (e) => e,
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/^E\t/m);
  });
});

interface Frame {
  rows: string[];
  /** cells drawn in the flow highlight: "row:col:text" */
  flow: string[];
  status: string;
  /** the writes the view asked for since the last frame, tab-separated */
  outbox: string[];
}

/** Drive the pane's view in Lua 5.4 with a script of `size`, `key` and `render` lines. */
function drive(script: string[], modelFile?: string): Frame[] {
  const args = [join(POC, "drive.lua"), ui, ...(modelFile ? [modelFile] : [])];
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

  it("shows each thread under the block it is on, with who said what", async () => {
    const file = join(tmp, "threads.txt");
    await writeFile(file, (await bridge("list", reviewId)).stdout);
    const [f] = drive(["size 120 40", `threads ${file}`, "key G", "render 0"]);
    const s = screen(f!);
    expect(s).toContain("Drain first?");
    expect(s).toMatch(/you +Drain first\?|you: Drain first\?/);
  });

  it("writes a comment on a clicked block, held for the review or asked at once", async () => {
    const frames = drive([
      "size 120 40",
      "render 0",
      "clicktext How a delivery works today",
      "key c",
      "type nj ] the lease?",
      "key enter",
      "render 0",
      "key c",
      "type ask it",
      "key tab",
      "key enter",
      "render 0",
    ]);
    const bid = bidOf("How a delivery works today");
    expect(frames[1]!.outbox).toEqual([`create\tdocument\t${bid}\treview\tnj ] the lease?`]);
    expect(frames[2]!.outbox).toEqual([`create\tdocument\t${bid}\task\task it`]);
  });

  it("submits the review with a decision, by key or by clicking it", async () => {
    const frames = drive([
      "size 120 40",
      "key R",
      "render 0",
      "key tab",
      "type fix the lease",
      "key enter",
      "render 0",
      "key R",
      "render 0",
      "clicktext Approve",
      "render 0",
    ]);
    expect(screen(frames[0]!)).toMatch(/Approve/);
    expect(frames[1]!.outbox).toEqual(["submit\trequest-changes\tfix the lease"]);
    expect(frames[3]!.outbox).toEqual(["submit\tapprove\t"]);
  });

  it("replies to and resolves a thread", async () => {
    const file = join(tmp, "threads2.txt");
    await writeFile(file, (await bridge("list", reviewId)).stdout);
    const [f] = drive([
      "size 120 40",
      `threads ${file}`,
      "key t",
      "key r",
      "type ok",
      "key enter",
      "key x",
      "render 0",
    ]);
    expect(f!.outbox).toHaveLength(2);
    expect(f!.outbox[0]).toMatch(/^reply\t\w+\tok$/);
    expect(f!.outbox[1]).toMatch(/^status\t\w+\t(resolved|open)$/);
  });

  it("answers the mouse: a click selects a part, opens an anchor, and the wheel scrolls", async () => {
    const [start, part, anchor, wheeled] = drive([
      "size 120 40",
      "render 0",
      "clicktext Outbox",
      "render 0",
      "clicktext checks the sender",
      "render 0",
      "wheel down 10 10",
      "wheel down 10 10",
      "render 0",
    ]);
    expect(screen(part!)).toContain("node · relay.outbox");
    expect(screen(anchor!)).toContain("src/http/receive.ts:10-15");
    expect(wheeled!.rows[1]).not.toBe(anchor!.rows[1]);
    expect(start!.rows[1]).not.toBe(wheeled!.rows[1]);
  });

  it("does by name what the keys and the mouse do, for an agent driving it", async () => {
    const bid = bidOf("Failure handling");
    const [selected, commented] = drive([
      "size 120 40",
      "act select target=node:relay.worker",
      "render 0",
      `act comment target=block:${bid}|body=Is thirty seconds enough?|mode=ask`,
      "act submit decision=close|body=superseded",
      "act comment target=block:nope|body=x",
      "render 0",
    ]);
    expect(screen(selected!)).toContain("node · relay.worker");
    expect(commented!.outbox).toEqual([
      `create\tdocument\t${bid}\task\tIs thirty seconds enough?`,
      "submit\tclose\tsuperseded",
    ]);
    expect(commented!.status).toContain("no block or part block:nope");
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
      expect(files.sort()).toEqual(["diagram.lua", "model.lua", "threads.lua", "view.lua"]);
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

    it("answers the mouse in a real terminal: a part, an anchor, the wheel", async () => {
      // A real client on a pty, attached the way a terminal emulator attaches,
      // sends the mouse reports a terminal sends (SGR); tmux forwards them to
      // thurbox, which asked for mouse tracking.
      tmux("set", "-g", "mouse", "on");
      tmux("set", "-g", "status", "off");
      const client = spawn(
        "script",
        ["-qfc", `stty cols 160 rows 45; exec ${tmuxBin} -L view attach -t poc`, "/dev/null"],
        { env, stdio: ["pipe", "ignore", "ignore"] },
      );
      await new Promise((r) => setTimeout(r, 1000));
      const at = (text: string) => {
        const rows = capture().split("\n");
        const row = rows.findIndex((r) => r.includes(text));
        if (row < 0) throw new Error(`nothing on screen shows ${text}`);
        return { row: row + 1, col: [...rows[row]!.slice(0, rows[row]!.indexOf(text))].length + 1 };
      };
      const sgr = (button: number, row: number, col: number, release = false) =>
        client.stdin!.write(`\x1b[<${button};${col};${row}${release ? "m" : "M"}`);
      const click = (text: string, offset = 1) => {
        const { row, col } = at(text);
        sgr(0, row, col + offset);
        sgr(0, row, col + offset, true);
      };
      const state = async () =>
        JSON.parse((await execFileP("thurbox-cli", ["ui", "state", "--json"], { env })).stdout)
          .plugin_state["plugins/85_thurview_poc.lua"];
      const settle = async (want: (s: any) => boolean, what: string) => {
        const deadline = Date.now() + 10_000;
        let s: any;
        while (Date.now() < deadline) {
          s = await state();
          if (want(s)) return s;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`the pane never reported ${what}: ${JSON.stringify(s)}`);
      };
      tmux("send-keys", "-t", "poc", "F3");
      await until((s) => s.includes("│ Outbox"), "the map");
      click("│ Outbox", 2);
      await settle((s) => s.node === "relay.outbox" && s.focus === "map", "the clicked part");
      click("checks the sender");
      await settle((s) => s.anchor === "verify", "the clicked anchor");
      const before = capture().split("\n")[3];
      const { row, col } = at("checks the sender");
      for (let i = 0; i < 3; i++) sgr(65, row, col);
      await until((s) => s.split("\n")[3] !== before, "the document scrolled by the wheel");
      client.stdin!.end("\x02d");
      await new Promise((r) => client.once("exit", r));
    });

    it("writes through thurview once you grant it run: by the agent's CLI and by the keyboard", async () => {
      // The grant is yours to give, in thurbox's own settings: F6, the Interface
      // tab, the pane's row, t.
      tmux("send-keys", "-t", "poc", "F6");
      await until((s) => s.includes("Settings"), "the settings");
      tmux("send-keys", "-t", "poc", "]");
      await until((s) => s.includes("85_thurview_poc.lua"), "the interface tab");
      for (let i = 0; i < 20 && !/▸ \S+ plugins\/85_thurview_poc\.lua/.test(capture()); i++) {
        tmux("send-keys", "-t", "poc", "j");
        await new Promise((r) => setTimeout(r, 150));
      }
      tmux("send-keys", "-t", "poc", "t");
      await new Promise((r) => setTimeout(r, 300));
      tmux("send-keys", "-t", "poc", "Escape");
      const ui = async (...a: string[]) =>
        JSON.parse((await execFileP("thurbox-cli", ["ui", ...a, "--json"], { env })).stdout);
      await new Promise((r) => setTimeout(r, 300));
      if ((await ui("state")).focused_pane !== "thurview") tmux("send-keys", "-t", "poc", "F3");
      const state = async () => {
        const all = await ui("state");
        return all.plugin_state["plugins/85_thurview_poc.lua"];
      };
      const settle = async (want: (s: any) => boolean, what: string) => {
        const deadline = Date.now() + 15_000;
        let s: any;
        while (Date.now() < deadline) {
          s = await state();
          if (s && want(s)) return s;
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`the pane never reported ${what}: ${JSON.stringify(s)}`);
      };
      await settle((s) => s.writable === true, "that it can write");

      // An agent: one typed action, no keystrokes, no screen to read.
      const bid = bidOf("Open questions");
      await ui(
        "action",
        "thurview.comment",
        "--arg",
        `target=block:${bid}`,
        "--arg",
        "body=From the CLI",
        "--arg",
        "mode=ask",
      );
      await settle((s) => s.notice === "" && s.threads >= 1, "the comment saved");

      // A person: c, type, Enter.
      tmux("send-keys", "-t", "poc", "c");
      await until((s) => s.includes("Add to review"), "the composer");
      tmux("send-keys", "-t", "poc", "-l", "typed in the pane");
      tmux("send-keys", "-t", "poc", "Enter");
      await settle((s) => s.threads_in_review >= 1, "the review comment saved");

      const listed = JSON.stringify(
        await cli(repo, home, ["threads", "list", "--review", reviewId]),
      );
      expect(listed).toContain("From the CLI");
      expect(listed).toContain("typed in the pane");
    });
  },
);
