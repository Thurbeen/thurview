import { createHmac, timingSafeEqual } from "node:crypto";
import type { RelayConfig } from "../config.js";
import { enqueue } from "../outbox/outbox.js";

export interface Incoming {
  body: string;
  signature: string;
}

/** Verify the sender's HMAC before anything is stored. */
export function verify(config: RelayConfig, event: Incoming): boolean {
  const want = createHmac("sha256", config.signingSecret).update(event.body).digest();
  const got = Buffer.from(event.signature, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** POST /events: verify, store once, answer 202 before any delivery runs. */
export async function receive(config: RelayConfig, event: Incoming): Promise<number> {
  if (!verify(config, event)) return 401;
  await enqueue(event.body);
  return 202;
}
