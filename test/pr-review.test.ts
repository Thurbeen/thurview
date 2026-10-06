import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChangeRequest,
  InlineComment,
  Note,
  PriorThread,
  RepoId,
} from "../src/forge/types.js";
import { CATEGORIES, SEVERITIES, CONFIDENCE } from "../src/pr-review/categories.js";
import {
  parsePass,
  renderSummary,
  summaryWords,
  SUMMARY_WORDS,
  type Pass,
} from "../src/pr-review/format.js";
import {
  sync,
  readState,
  waitForEvent,
  stopReview,
  startReview,
  type ReviewForge,
} from "../src/pr-review/follow.js";

const ROOT = join(import.meta.dirname, "..");
const REPO: RepoId = { host: "github.com", path: "acme/web" };
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);

/**
 * A forge held in memory, so the follow loop is driven across pushes, merges
 * and restarts without a network. It keeps what a real forge keeps - notes,
 * threads, labels and the head - and nothing of the loop's own.
 */
class MemoryForge implements ReviewForge {
  readonly id = "github";
  cr: ChangeRequest = {
    number: "7",
    title: "Retry the upload",
    url: "https://github.com/acme/web/pull/7",
    state: "open",
    author: "dev",
    head: SHA(1),
    headBranch: "retry",
    base: SHA(9),
    baseBranch: "main",
    fromFork: false,
    draft: false,
    body: "",
    labels: [],
  };
  notesList: Note[] = [];
  threads: PriorThread[] = [];
  posted = 0;
  edited = 0;
  private nextId = 100;

  async get(): Promise<ChangeRequest> {
    return { ...this.cr, labels: [...this.cr.labels] };
  }
  async prior() {
    return { passes: [], threads: this.threads.map((t) => ({ ...t, messages: [...t.messages] })) };
  }
  async notes(): Promise<Note[]> {
    return this.notesList.map((n) => ({ ...n }));
  }
  async postNote(_r: RepoId, _c: ChangeRequest, body: string): Promise<Note> {
    this.posted++;
    const n = { id: String(this.nextId++), author: "bot", body };
    this.notesList.push(n);
    return n;
  }
  async editNote(_r: RepoId, _c: ChangeRequest, id: string, body: string): Promise<void> {
    this.edited++;
    const n = this.notesList.find((x) => x.id === id);
    if (!n) throw new Error(`no note ${id}`);
    n.body = body;
  }
  async comment(_r: RepoId, cr: ChangeRequest, c: InlineComment): Promise<void> {
    this.threads.push({
      id: `T${this.nextId++}`,
      author: "bot",
      path: c.path,
      line: c.line,
      side: c.side ?? "head",
      resolved: false,
      outdated: false,
      commit: cr.head,
      messages: [{ author: "bot", body: c.body }],
    });
  }
  async reply(
    _r: RepoId,
    _c: ChangeRequest,
    id: string,
    body: string | undefined,
    resolve: boolean,
  ) {
    const t = this.threads.find((x) => x.id === id)!;
    if (body) t.messages.push({ author: "bot", body });
    if (resolve) t.resolved = true;
    return { replied: Boolean(body), resolved: resolve, notes: [] };
  }
  /** Someone pushed. */
  push(n: number) {
    this.cr.head = SHA(n);
  }
  summaries(): Note[] {
    return this.notesList.filter((n) => n.body.startsWith("<!-- thurview-pr-review"));
  }
}

const base: Pass = {
  confidence: 4,
  reason: "Safe once the retry loop is bounded.",
  risk: ["The upload path retries on every error, including a 4xx."],
  change: "Retries a failed upload three times with backoff.",
  findings: [],
  fixed: [],
};

const UNBOUNDED = {
  category: "bug" as const,
  severity: "blocking" as const,
  path: "src/upload.ts",
  line: 42,
  title: "The retry loop never stops on a 4xx.",
  body: "Return on any status below 500.",
};

function ctx(forge: MemoryForge) {
  return { forge, repo: REPO, cr: forge.cr };
}

async function pass(forge: MemoryForge, p: Partial<Pass>) {
  return sync({ forge, repo: REPO, cr: await forge.get() }, { ...base, ...p });
}

describe("the summary", () => {
  it("is posted once and edited in place across three pushes", async () => {
    const forge = new MemoryForge();
    await pass(forge, { confidence: 2, reason: "One blocking bug.", findings: [UNBOUNDED] });
    forge.push(2);
    await pass(forge, { confidence: 2, reason: "Still one blocking bug." });
    forge.push(3);
    await pass(forge, { confidence: 1, reason: "It breaks the upload." });
    expect(forge.posted).toBe(1);
    expect(forge.edited).toBe(2);
    expect(forge.summaries()).toHaveLength(1);
    const body = forge.summaries()[0]!.body;
    expect(body).toContain(`"head":"${SHA(3)}"`);
    expect(body).toContain("Confidence 1/5");
    // Three passes, one finding: never re-posted while its thread is open.
    expect(forge.threads).toHaveLength(1);
  });

  it("is recovered from the forge alone, as after a restart", async () => {
    const forge = new MemoryForge();
    await pass(forge, { findings: [UNBOUNDED], confidence: 2 });
    const state = await readState(ctx(forge));
    expect(state.summary?.marker.head).toBe(SHA(1));
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ category: "bug", severity: "blocking", open: true });
  });

  it("counts open findings per category and severity", async () => {
    const forge = new MemoryForge();
    await pass(forge, {
      confidence: 2,
      findings: [
        UNBOUNDED,
        { ...UNBOUNDED, line: 50, title: "Second bug.", severity: "non-blocking" },
        { ...UNBOUNDED, category: "docs", severity: "nit", title: "Typo.", line: 3 },
      ],
    });
    const body = forge.summaries()[0]!.body;
    expect(body).toMatch(/\| Bug \| 1 \| 1 \| 0 \|/);
    expect(body).toMatch(/\| Docs \| 0 \| 0 \| 1 \|/);
  });

  it("opens with the next step", async () => {
    const forge = new MemoryForge();
    await pass(forge, { findings: [UNBOUNDED], confidence: 2 });
    const lines = forge.summaries()[0]!.body.split("\n");
    expect(lines[1]).toBe("Next: @dev — fix the 1 blocking finding.");
  });

  it("links the full review only when there is one", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    expect(forge.summaries()[0]!.body).not.toContain("Full review");
    await pass(forge, { reviewUrl: "https://reviews.example.com/7/" });
    expect(forge.summaries()[0]!.body).toContain("[Full review](https://reviews.example.com/7/)");
  });

  it("holds the word budget", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const head = { head: SHA(1), state: "active" as const, seen: "0" };
    const fits = renderSummary({ ...base, change: words(80) }, head, "dev", []);
    expect(summaryWords(fits)).toBeLessThanOrEqual(SUMMARY_WORDS);
    expect(() => renderSummary({ ...base, change: words(SUMMARY_WORDS) }, head, "dev", [])).toThrow(
      /words/,
    );
  });

  it("refuses a high confidence beside an open blocking finding", async () => {
    const forge = new MemoryForge();
    await expect(pass(forge, { confidence: 4, findings: [UNBOUNDED] })).rejects.toThrow(/blocking/);
    expect(forge.notesList).toHaveLength(0);
    expect(forge.threads).toHaveLength(0);
  });
});

describe("inline findings", () => {
  it("resolves the thread of a fixed finding with a one-line reply", async () => {
    const forge = new MemoryForge();
    await pass(forge, { confidence: 2, findings: [UNBOUNDED] });
    const id = (await readState(ctx(forge))).findings[0]!.id;
    forge.push(2);
    await pass(forge, { fixed: [id] });
    const t = forge.threads[0]!;
    expect(t.resolved).toBe(true);
    expect(t.messages.at(-1)!.body).toBe(`Fixed in ${SHA(2).slice(0, 7)}.`);
    expect(forge.summaries()[0]!.body).toContain("No open findings.");
  });

  it("opens a new thread for a new finding, and only for it", async () => {
    const forge = new MemoryForge();
    await pass(forge, { confidence: 2, findings: [UNBOUNDED] });
    forge.push(2);
    const fresh = { ...UNBOUNDED, line: 80, title: "The backoff overflows after 30 tries." };
    await pass(forge, { confidence: 2, findings: [UNBOUNDED, fresh] });
    expect(forge.threads).toHaveLength(2);
    expect(forge.threads[1]!.line).toBe(80);
    expect(forge.threads[1]!.commit).toBe(SHA(2));
  });

  it("refuses to resolve a finding it does not know", async () => {
    const forge = new MemoryForge();
    await expect(pass(forge, { fixed: ["nope"] })).rejects.toThrow(/nope/);
  });

  it("carries a category, a severity and a suggestion", async () => {
    const forge = new MemoryForge();
    await pass(forge, {
      confidence: 2,
      signoff: "— the agent",
      findings: [{ ...UNBOUNDED, suggestion: "if (res.status < 500) return res;" }],
    });
    const body = forge.threads[0]!.messages[0]!.body;
    expect(body).toContain("**Bug · blocking:** The retry loop never stops on a 4xx.");
    expect(body).toContain("```suggestion\nif (res.status < 500) return res;\n```");
    expect(body.trimEnd().split("\n").at(-1)).toBe("— the agent");
  });

  it("prefixes a nit", async () => {
    const forge = new MemoryForge();
    await pass(forge, { findings: [{ ...UNBOUNDED, severity: "nit", category: "docs" }] });
    expect(forge.threads[0]!.messages[0]!.body).toContain("nit: **Docs:**");
  });
});

describe("the categories", () => {
  it("are a closed set", () => {
    const text = JSON.stringify({ ...base, findings: [{ ...UNBOUNDED, category: "style" }] });
    expect(() => parsePass(text, "pass.json")).toThrow(/category/);
    expect(Object.keys(CATEGORIES)).toEqual([
      "bug",
      "security",
      "performance",
      "reliability",
      "compatibility",
      "maintainability",
      "tests",
      "docs",
    ]);
    expect(SEVERITIES).toEqual(["blocking", "non-blocking", "nit"]);
    expect(Object.keys(CONFIDENCE)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("are the ones the skill documents", () => {
    const skill = readFileSync(join(ROOT, "skills/thurview-pr-review/SKILL.md"), "utf8");
    for (const [id, c] of Object.entries(CATEGORIES))
      expect(skill.replace(/ {2,}/g, " ")).toContain(`| \`${id}\` | ${c.definition} |`);
  });
});

describe("following the change request", () => {
  const fast = { interval: 0, timeout: 60, sleep: async () => {} };

  it("reports a push as the head the last pass did not see", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    let polls = 0;
    const ev = await waitForEvent(forge, REPO, "7", {
      ...fast,
      sleep: async () => {
        if (++polls === 2) forge.push(2);
      },
    });
    expect(ev).toMatchObject({ event: "push", since: SHA(1), head: SHA(2) });
  });

  it("reports the first review when nothing was posted yet", async () => {
    const forge = new MemoryForge();
    const ev = await waitForEvent(forge, REPO, "7", fast);
    expect(ev).toMatchObject({ event: "push", since: null, head: SHA(1) });
  });

  it.each(["merged", "closed"] as const)("stops when it is %s", async (state) => {
    const forge = new MemoryForge();
    await pass(forge, {});
    forge.cr.state = state;
    const ev = await waitForEvent(forge, REPO, "7", fast);
    expect(ev.event).toBe(state);
    const body = forge.summaries()[0]!.body;
    expect(body).toContain(`"state":"${state}"`);
    expect(body.split("\n")[1]).toBe(`Review ended: ${state} at ${SHA(1).slice(0, 7)}.`);
    expect(forge.summaries()).toHaveLength(1);
  });

  it("stops on the stop label", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    forge.cr.labels.push("thurview:stop");
    const ev = await waitForEvent(forge, REPO, "7", fast);
    expect(ev.event).toBe("stopped");
    expect(forge.summaries()[0]!.body).toContain("Review stopped");
  });

  it("stops on a stop command, and a start resumes past it", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    await forge.postNote(REPO, forge.cr, "/thurview stop");
    expect((await waitForEvent(forge, REPO, "7", fast)).event).toBe("stopped");
    // A restart reads the same state back from the forge.
    expect((await waitForEvent(forge, REPO, "7", fast)).event).toBe("stopped");
    await startReview(ctx(forge));
    forge.push(2);
    expect((await waitForEvent(forge, REPO, "7", fast)).event).toBe("push");
  });

  it("stops when asked from the command line", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    await stopReview(ctx(forge));
    expect(forge.summaries()[0]!.body).toContain("Review stopped");
    expect((await waitForEvent(forge, REPO, "7", fast)).event).toBe("stopped");
    await expect(pass(forge, {})).rejects.toThrow(/stopped/);
  });

  it("gives up quietly at the timeout", async () => {
    const forge = new MemoryForge();
    await pass(forge, {});
    let t = 0;
    const ev = await waitForEvent(forge, REPO, "7", {
      interval: 10,
      timeout: 25,
      sleep: async (s) => void (t += s),
      now: () => t,
    });
    expect(ev.event).toBe("none");
  });
});
