import type { ComponentKind } from "@/engine/model/types";

export type Control =
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; unit?: string; help?: string; scale?: number }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; help?: string }
  | { key: string; label: string; type: "toggle"; help?: string };

/** The knobs each component exposes in the inspector. */
export const CONTROLS: Record<ComponentKind, Control[]> = {
  client: [
    { key: "rps", label: "Requests per second", type: "range", min: 0, max: 1000, step: 5 },
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
    { key: "keySpace", label: "Distinct keys", type: "range", min: 100, max: 100000, step: 100, help: "How many different items clients ask for." },
    {
      key: "hotShare",
      label: "Traffic to hottest 1% of keys",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      unit: "%",
      scale: 100,
      help: "Real traffic is skewed: a few items get most requests.",
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
      ],
    },
    { key: "healthChecks", label: "Health checks", type: "toggle", help: "Stop sending traffic to servers that are down." },
  ],
  server: [
    { key: "workers", label: "Workers", type: "range", min: 1, max: 64, step: 1, help: "Requests it can work on at once." },
    { key: "serviceMs", label: "Work per request", type: "range", min: 1, max: 500, step: 1, unit: "ms" },
    { key: "queueLimit", label: "Queue limit", type: "range", min: 0, max: 1000, step: 10, help: "Waiting requests beyond this are rejected." },
  ],
  cache: [
    { key: "capacity", label: "Capacity", type: "range", min: 10, max: 20000, step: 10, unit: "keys" },
    { key: "ttlMs", label: "Time to live", type: "range", min: 500, max: 120000, step: 500, unit: "ms", help: "How long an entry stays before it expires." },
  ],
  database: [
    { key: "workers", label: "Connections", type: "range", min: 1, max: 64, step: 1 },
    { key: "serviceMs", label: "Work per query", type: "range", min: 1, max: 500, step: 1, unit: "ms" },
    { key: "queueLimit", label: "Queue limit", type: "range", min: 0, max: 1000, step: 10 },
  ],
};

export const KIND_BLURB: Record<ComponentKind, string> = {
  client: "Users sending requests",
  loadBalancer: "Spreads requests across servers",
  server: "Does work with a pool of workers",
  cache: "Answers repeat reads from memory",
  database: "Stores data; slow and limited",
};
