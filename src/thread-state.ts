import type { Thread } from "./store.js";
import type { Presence } from "./presence.js";

/** Threads the agent must act on: open, submitted, and the last message is from the reviewer. */
export function needsAgent(th: Thread): boolean {
  if (th.status !== "open" || !th.submitted) return false;
  const last = th.messages[th.messages.length - 1];
  return !!last && last.role === "reviewer";
}

/**
 * Where the reader's last message in a thread stands. This is the one rule the
 * CLI and the browser both answer from, so the receipt the reader reads and the
 * queue the agent drains cannot disagree.
 *
 * - `held`: written but not submitted; no agent can see it yet.
 * - `queued`: submitted, unanswered, nobody listening. It waits for an agent.
 * - `listening`: submitted, unanswered, an agent is in `thurview wait` now.
 * - `answered`: the agent spoke last.
 * - `closed`: resolved; nobody owes anything.
 */
export type Delivery = "held" | "queued" | "listening" | "answered" | "closed";

export function deliveryOf(th: Thread, agent: Presence): Delivery {
  if (th.status === "resolved") return "closed";
  if (!th.submitted) return "held";
  if (!needsAgent(th)) return "answered";
  return agent.attached ? "listening" : "queued";
}
