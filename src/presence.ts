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

export const NOBODY: Presence = { attached: false, lastSeen: null };

export async function presenceOf(reviewId: string): Promise<Presence> {
  const rec = await readJson<{ at: string; pid: number }>(agentFile(reviewId));
  if (!rec) return NOBODY;
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) return NOBODY;
  return { attached: Date.now() - at < TTL_MS, lastSeen: rec.at };
}

/** Announce that this process is waiting on the review until `stop()` is called. */
export function attach(reviewId: string): { stop: () => Promise<void> } {
  let stopped = false;
  const beat = () =>
    writeJson(agentFile(reviewId), { at: now(), pid: process.pid }).catch(() => {});
  void beat();
  const timer = setInterval(() => {
    if (!stopped) void beat();
  }, BEAT_MS);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await rm(agentFile(reviewId), { force: true });
    },
  };
}
