export interface RelayConfig {
  /** shared secret the sender signs each event with */
  signingSecret: string;
  /** subscriber endpoints, in delivery order */
  subscribers: string[];
  /** first retry delay, doubled on every failure */
  retryBaseMs: number;
  /** attempts before an event is given up on */
  maxAttempts: number;
}

export function loadConfig(env: Record<string, string | undefined>): RelayConfig {
  return {
    signingSecret: env["RELAY_SECRET"] ?? "",
    subscribers: (env["RELAY_SUBSCRIBERS"] ?? "").split(",").filter(Boolean),
    retryBaseMs: Number(env["RELAY_RETRY_BASE_MS"] ?? 500),
    maxAttempts: Number(env["RELAY_MAX_ATTEMPTS"] ?? 8),
  };
}
