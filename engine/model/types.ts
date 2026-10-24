/** Shared types between the engine, the worker and the UI. */

export type ComponentKind = "client" | "loadBalancer" | "server" | "cache" | "database";

export type TrafficPattern = "steady" | "spike" | "ramp";
export type LbStrategy = "roundRobin" | "leastConnections" | "random";

export interface ClientConfig {
  rps: number;
  pattern: TrafficPattern;
  keySpace: number;
  /** Share of requests that go to the hottest 1% of keys (0..1). */
  hotShare: number;
}

export interface LoadBalancerConfig {
  strategy: LbStrategy;
  healthChecks: boolean;
}

export interface ServerConfig {
  workers: number;
  serviceMs: number;
  queueLimit: number;
}

export interface CacheConfig {
  capacity: number;
  ttlMs: number;
}

export interface DatabaseConfig {
  workers: number;
  serviceMs: number;
  queueLimit: number;
}

export interface ConfigByKind {
  client: ClientConfig;
  loadBalancer: LoadBalancerConfig;
  server: ServerConfig;
  cache: CacheConfig;
  database: DatabaseConfig;
}

export type AnyConfig = ConfigByKind[ComponentKind];

export interface GraphNode {
  id: string;
  kind: ComponentKind;
  label: string;
  config: AnyConfig;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type NodeStatus = "idle" | "ok" | "warning" | "critical" | "down";

export interface NodeStats {
  id: string;
  kind: ComponentKind;
  status: NodeStatus;
  down: boolean;
  slowFactor: number;
  /** Requests completed successfully per second at this node. */
  okPerSec: number;
  errorsPerSec: number;
  errorRate: number;
  p50: number;
  p99: number;
  queue: number;
  queueLimit: number;
  busy: number;
  workers: number;
  /** Smoothed busy / workers, 0..1, including workers waiting on a downstream answer. */
  utilization: number;
  /** Like utilization, but only workers doing their own work. */
  workUtilization: number;
  /** Cache only: share of lookups served from cache in the window. */
  hitRatio?: number;
  /** Client only: requests sent per second right now. */
  sendingRps?: number;
  bottleneck: boolean;
}

export interface Flight {
  edgeId: string;
  /** Forward = request travelling downstream; back = response travelling upstream. */
  dir: "fwd" | "back";
  ok: boolean;
}

export interface Incident {
  id: number;
  time: number;
  nodeId: string;
  severity: "info" | "warning" | "critical";
  text: string;
}

export interface Snapshot {
  time: number;
  nodes: Record<string, NodeStats>;
  flights: Flight[];
  incidents: Incident[];
}

export type FaultAction =
  | { type: "crash"; nodeId: string }
  | { type: "recover"; nodeId: string }
  | { type: "slow"; nodeId: string; factor: number };
