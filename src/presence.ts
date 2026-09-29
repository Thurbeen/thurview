import { rm } from "node:fs/promises";
import { agentFile, readJson, writeJson, now } from "./store.js";

/**
 * Whether an agent is listening to a review right now, so the reader is told
 * the truth about where their question went: an agent in `thurview wait` reads
 * it within a second; with nobody attached it is queued until one next checks.
 * Presence is never inferred - only a live `wait` writes it.
 */
export interface Presence {
  attached: boolean;
  /** when the attached agent last checked in, null when none ever has */
  lastSeen: string | null;
}

/** A heartbeat older than this is a dead `wait`, not a listening agent. */
const TTL_MS = 15_000;
const BEAT_MS = 3_000;
/**
 * How long an agent that `wait` handed a question to still counts as listening:
 * it is answering, and runs `wait` again once it has. A heartbeat takes over
 * the moment it does; an agent that never comes back stops counting after this.
 */
const ANSWER_MS = 10 * 60_000;

export const NOBODY: Presence = { attached: false, lastSeen: null };

interface Heartbeat {
  at: string;
  pid: number;
  /** listening until then, when later than `at` plus the heartbeat TTL */
  until?: string;
}

export async function presenceOf(reviewId: string): Promise<Presence> {
  const rec = await readJson<Heartbeat>(agentFile(reviewId));
  if (!rec) return NOBODY;
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) return NOBODY;
  const until = rec.until ? Date.parse(rec.until) : at + TTL_MS;
  return { attached: Date.now() < until, lastSeen: rec.at };
}

/**
 * Announce that this process is waiting on the review. `stop()` says nobody is
 * listening any more; `handOff()` says the agent went to answer and is coming
 * back.
 */
export function attach(reviewId: string): {
  stop: () => Promise<void>;
  handOff: () => Promise<void>;
} {
  let stopped = false;
  // A beat still being written when `wait` ends would land after the removal
  // and claim a listener for another TTL, so ending waits for it first.
  let writing: Promise<void> = Promise.resolve();
  const write = (rec: Heartbeat) => {
    writing = writeJson(agentFile(reviewId), rec).catch(() => {});
    return writing;
  };
  const beat = () => void write({ at: now(), pid: process.pid });
  beat();
  const timer = setInterval(() => {
    if (!stopped) beat();
  }, BEAT_MS);
  timer.unref();
  const end = async () => {
    stopped = true;
    clearInterval(timer);
    await writing;
  };
  return {
    stop: async () => {
      await end();
      await rm(agentFile(reviewId), { force: true });
    },
    handOff: async () => {
      await end();
      await write({
        at: now(),
        pid: process.pid,
        until: new Date(Date.now() + ANSWER_MS).toISOString(),
      });
    },
  };
}
