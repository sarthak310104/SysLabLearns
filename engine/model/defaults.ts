import type { ComponentKind, ConfigByKind } from "./types";

export const DEFAULT_CONFIG: ConfigByKind = {
  client: { rps: 50, pattern: "steady", keySpace: 10000, hotShare: 0.5 },
  loadBalancer: { strategy: "roundRobin", healthChecks: false },
  server: { workers: 4, serviceMs: 40, queueLimit: 100 },
  cache: { capacity: 1000, ttlMs: 30000 },
  database: { workers: 8, serviceMs: 25, queueLimit: 200 },
};

export const KIND_LABEL: Record<ComponentKind, string> = {
  client: "Clients",
  loadBalancer: "Load balancer",
  server: "Server",
  cache: "Cache",
  database: "Database",
};

/** Which component may send requests to which. */
export const ALLOWED_TARGETS: Record<ComponentKind, ComponentKind[]> = {
  client: ["loadBalancer", "server", "cache"],
  loadBalancer: ["server"],
  server: ["cache", "database", "server", "loadBalancer"],
  cache: ["database", "server"],
  database: [],
};

export function canConnect(from: ComponentKind, to: ComponentKind): boolean {
  return ALLOWED_TARGETS[from].includes(to);
}

export function defaultConfig<K extends ComponentKind>(kind: K): ConfigByKind[K] {
  return { ...DEFAULT_CONFIG[kind] };
}
