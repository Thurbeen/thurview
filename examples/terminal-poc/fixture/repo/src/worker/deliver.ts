import type { RelayConfig } from "../config.js";
import { lease, reschedule, done } from "../outbox/outbox.js";

/** Doubling backoff, capped at ten minutes. */
export function backoff(config: RelayConfig, attempts: number): number {
  return Math.min(config.retryBaseMs * 2 ** attempts, 600_000);
}

/** One pass: lease an event, post it to every subscriber, settle the row. */
export async function tick(config: RelayConfig, now: number): Promise<boolean> {
  const event = await lease(now);
  if (!event) return false;
  const results = await Promise.all(
    config.subscribers.map((url) => fetch(url, { method: "POST", body: event.body })),
  );
  if (results.every((r) => r.ok)) {
    await done(event.id);
  } else if (event.attempts + 1 >= config.maxAttempts) {
    // Today the event is dropped here, silently.
    await done(event.id);
  } else {
    await reschedule(event.id, event.attempts + 1, now + backoff(config, event.attempts));
  }
  return true;
}
