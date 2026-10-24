import type { ComponentKind } from "@/engine/model/types";

interface Base {
  key: string;
  label: string;
  help?: string;
  /** Advanced controls are tucked under "Timeouts and retries" or "More settings". */
  advanced?: boolean;
}

export type Control =
  | (Base & { type: "range"; min: number; max: number; step: number; unit?: string; scale?: number; zeroLabel?: string })
  | (Base & { type: "select"; options: { value: string; label: string }[] })
  | (Base & { type: "toggle" });

const pct = { unit: "%", scale: 100 } as const;

/** The knobs each component exposes in the inspector. */
export const CONTROLS: Record<ComponentKind, Control[]> = {
  client: [
    { key: "rps", label: "Requests per second", type: "range", min: 0, max: 1500, step: 5 },
    {
      key: "pattern",
      label: "Traffic shape",
      type: "select",
      options: [
        { value: "steady", label: "Steady" },
        { value: "spike", label: "Spikes (4x for 2 s every 10 s)" },
        { value: "ramp", label: "Ramp up over 30 s" },
      ],
    },
    { key: "writeShare", label: "Writes", type: "range", min: 0, max: 1, step: 0.05, ...pct, help: "The rest are reads." },
    { key: "keySpace", label: "Distinct keys", type: "range", min: 100, max: 100000, step: 100, help: "How many different items clients ask for." },
    { key: "hotShare", label: "Traffic to hottest 1% of keys", type: "range", min: 0, max: 1, step: 0.05, ...pct, help: "Real traffic is skewed: a few items get most requests." },
    { key: "topKeyShare", label: "Traffic to one celebrity key", type: "range", min: 0, max: 0.6, step: 0.05, ...pct, help: "A single item everyone wants at once." },
    { key: "timeoutMs", label: "Give up after", type: "range", min: 0, max: 5000, step: 50, unit: "ms", zeroLabel: "Never", advanced: true },
    { key: "retries", label: "Retries", type: "range", min: 0, max: 5, step: 1, advanced: true, help: "Extra attempts after a failure or timeout." },
    {
      key: "backoff",
      label: "Wait between retries",
      type: "select",
      advanced: true,
      options: [
        { value: "none", label: "Retry immediately" },
        { value: "exponential", label: "Exponential backoff with jitter" },
      ],
    },
  ],
  loadBalancer: [
    {
      key: "strategy",
      label: "Routing strategy",
      type: "select",
      options: [
        { value: "roundRobin", label: "Round robin" },
        { value: "leastConnections", label: "Least connections" },
        { value: "random", label: "Random" },
        { value: "keyHash", label: "By key (shard router)" },
      ],
    },
    { key: "healthChecks", label: "Health checks", type: "toggle", help: "Stop sending traffic to targets that are down." },
    { key: "rateLimit", label: "Rate limit", type: "range", min: 0, max: 2000, step: 10, unit: "req/s", zeroLabel: "Off", advanced: true, help: "Reject anything above this, fast, before it reaches the servers." },
  ],
  server: [
    { key: "workers", label: "Workers", type: "range", min: 1, max: 128, step: 1, help: "Requests it can work on at once." },
    { key: "serviceMs", label: "Work per request", type: "range", min: 1, max: 500, step: 1, unit: "ms" },
    { key: "queueLimit", label: "Queue limit", type: "range", min: 0, max: 1000, step: 10, help: "Waiting requests beyond this are rejected." },
    { key: "timeoutMs", label: "Give up on downstream after", type: "range", min: 0, max: 5000, step: 50, unit: "ms", zeroLabel: "Never", advanced: true },
    { key: "breaker", label: "Circuit breaker", type: "toggle", advanced: true, help: "If most recent calls failed, fail fast for 3 s instead of calling again." },
  ],
  cache: [
    { key: "capacity", label: "Capacity", type: "range", min: 10, max: 20000, step: 10, unit: "keys" },
    { key: "ttlMs", label: "Time to live", type: "range", min: 500, max: 120000, step: 500, unit: "ms", help: "How long an entry stays before it expires." },
  ],
  database: [
    { key: "workers", label: "Connections", type: "range", min: 1, max: 64, step: 1 },
    { key: "serviceMs", label: "Work per query", type: "range", min: 1, max: 500, step: 1, unit: "ms" },
    { key: "queueLimit", label: "Queue limit", type: "range", min: 0, max: 1000, step: 10 },
    {
      key: "mode",
      label: "With another region",
      type: "select",
      options: [
        { value: "async", label: "Available: commit here, sync later" },
        { value: "sync", label: "Consistent: wait for the other region" },
      ],
      help: "Only matters when this database is linked to another database.",
    },
  ],
  replica: [
    { key: "workers", label: "Connections", type: "range", min: 1, max: 64, step: 1 },
    { key: "serviceMs", label: "Work per query", type: "range", min: 1, max: 500, step: 1, unit: "ms" },
    { key: "queueLimit", label: "Queue limit", type: "range", min: 0, max: 1000, step: 10 },
    { key: "applyMs", label: "Time to apply a write", type: "range", min: 0.5, max: 50, step: 0.5, unit: "ms", help: "Slower when the replica is busy serving reads." },
  ],
  queue: [
    { key: "capacity", label: "Capacity", type: "range", min: 10, max: 20000, step: 10, unit: "messages" },
    { key: "maxRetries", label: "Deliveries before giving up", type: "range", min: 1, max: 10, step: 1, help: "Then the message goes to the dead-letter pile." },
  ],
};

export const KIND_BLURB: Record<ComponentKind, string> = {
  client: "Users sending requests",
  loadBalancer: "Spreads requests across targets",
  server: "Does work with a pool of workers",
  cache: "Answers repeat reads from memory",
  database: "Stores data; slow and limited",
  replica: "Read-only copy of a database",
  queue: "Holds work until a worker is free",
};
