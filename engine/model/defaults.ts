import type { AnyConfig, ComponentKind, ConfigByKind, Region } from "./types";

export const DEFAULT_CONFIG: ConfigByKind = {
  client: {
    rps: 50,
    pattern: "steady",
    keySpace: 10000,
    hotShare: 0.5,
    topKeyShare: 0,
    writeShare: 0,
    timeoutMs: 0,
    retries: 0,
    backoff: "exponential",
    retryBudget: 0,
  },
  loadBalancer: { strategy: "roundRobin", healthChecks: false, rateLimit: 0, rateLimitScope: "global" },
  server: { workers: 4, serviceMs: 40, queueLimit: 100, timeoutMs: 0, breaker: false, autoscale: false, maxWorkers: 32, bootSeconds: 10 },
  cache: { capacity: 1000, ttlMs: 30000 },
  database: { workers: 8, serviceMs: 25, queueLimit: 200, mode: "async" },
  replica: { workers: 8, serviceMs: 25, queueLimit: 200, applyMs: 3 },
  queue: { capacity: 5000, maxRetries: 3 },
};

export const KIND_LABEL: Record<ComponentKind, string> = {
  client: "Clients",
  loadBalancer: "Load balancer",
  server: "Server",
  cache: "Cache",
  database: "Database",
  replica: "Read replica",
  queue: "Queue",
};

/**
 * Which component may connect to which. Most links carry requests; a link
 * from a database to a replica or another database carries replication.
 */
export const ALLOWED_TARGETS: Record<ComponentKind, ComponentKind[]> = {
  client: ["loadBalancer", "server", "cache"],
  loadBalancer: ["server", "database", "replica", "cache"],
  server: ["cache", "database", "replica", "server", "loadBalancer", "queue"],
  cache: ["database", "replica", "server", "loadBalancer"],
  database: ["replica", "database"],
  replica: [],
  queue: ["server"],
};

export function canConnect(from: ComponentKind, to: ComponentKind): boolean {
  return ALLOWED_TARGETS[from].includes(to);
}

export function defaultConfig<K extends ComponentKind>(kind: K): ConfigByKind[K] {
  return { ...DEFAULT_CONFIG[kind] };
}

/** Fill in fields missing from older saved designs. */
export function withDefaults(kind: ComponentKind, config: Partial<AnyConfig> | undefined): AnyConfig {
  return { ...DEFAULT_CONFIG[kind], ...(config ?? {}) } as AnyConfig;
}

export const REGION_LABEL: Record<Region, string> = {
  mumbai: "Mumbai",
  frankfurt: "Frankfurt",
  virginia: "Virginia",
};

/** One-way network time between regions, in ms (roughly real-world). */
export const REGION_LATENCY: Record<Region, Record<Region, number>> = {
  mumbai: { mumbai: 1, frankfurt: 60, virginia: 95 },
  frankfurt: { mumbai: 60, frankfurt: 1, virginia: 45 },
  virginia: { mumbai: 95, frankfurt: 45, virginia: 1 },
};
