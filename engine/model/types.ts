/** Shared types between the engine, the worker and the UI. */

export type ComponentKind = "client" | "loadBalancer" | "server" | "cache" | "database" | "replica" | "queue";

export type TrafficPattern = "steady" | "spike" | "ramp";
export type LbStrategy = "roundRobin" | "leastConnections" | "random" | "keyHash" | "consistentHash";
export type Region = "mumbai" | "frankfurt" | "virginia";
export type Backoff = "none" | "exponential";
export type ReplicationMode = "async" | "sync";

export interface ClientConfig {
  rps: number;
  pattern: TrafficPattern;
  keySpace: number;
  /** Share of requests that go to the hottest 1% of keys (0..1). */
  hotShare: number;
  /** Share of requests that all go to one single key, a "celebrity" (0..1). */
  topKeyShare: number;
  /** Share of requests that are writes (0..1). */
  writeShare: number;
  /** Give up on an attempt after this long. 0 = wait forever. */
  timeoutMs: number;
  /** Extra attempts after a failure or timeout. */
  retries: number;
  backoff: Backoff;
  /** Retries allowed as a share of new requests over the last second. 0 = no cap. */
  retryBudget: number;
}

export interface LoadBalancerConfig {
  strategy: LbStrategy;
  healthChecks: boolean;
  /** Max requests per second let through; extra are rejected. 0 = no limit. */
  rateLimit: number;
  /** Whether the limit is shared by everyone or applies to each client separately. */
  rateLimitScope: "global" | "perClient";
}

export interface ServerConfig {
  workers: number;
  serviceMs: number;
  queueLimit: number;
  /** Give up waiting on a downstream call after this long. 0 = wait forever. */
  timeoutMs: number;
  /** Stop calling a downstream that keeps failing, and fail fast instead. */
  breaker: boolean;
  /** Add workers when busy (and remove them when idle), up to maxWorkers. */
  autoscale: boolean;
  maxWorkers: number;
  /** How long new workers take to start. */
  bootSeconds: number;
}

export interface CacheConfig {
  capacity: number;
  ttlMs: number;
}

export interface DatabaseConfig {
  workers: number;
  serviceMs: number;
  queueLimit: number;
  /** With a peer database: async = commit locally first; sync = wait for the peer. */
  mode: ReplicationMode;
}

export interface ReplicaConfig {
  workers: number;
  serviceMs: number;
  queueLimit: number;
  /** Time to apply one replicated write, when idle. Grows as the replica gets busy. */
  applyMs: number;
}

export interface QueueConfig {
  capacity: number;
  /** Deliveries per message before it is moved to the dead-letter pile. */
  maxRetries: number;
}

export interface ConfigByKind {
  client: ClientConfig;
  loadBalancer: LoadBalancerConfig;
  server: ServerConfig;
  cache: CacheConfig;
  database: DatabaseConfig;
  replica: ReplicaConfig;
  queue: QueueConfig;
}

export type AnyConfig = ConfigByKind[ComponentKind];

export interface GraphNode {
  id: string;
  kind: ComponentKind;
  label: string;
  config: AnyConfig;
  position: { x: number; y: number };
  /** Where it runs. Links between regions take real network time. Unset = same place as everything else. */
  region?: Region;
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
  bottleneck: boolean;

  /** Cache: share of lookups served from cache in the window. */
  hitRatio?: number;
  /** Client: new requests started per second right now. */
  sendingRps?: number;
  /** Client: attempts per second including retries. */
  attemptsPerSec?: number;
  /** Replica: share of reads answered with out-of-date data. */
  staleRate?: number;
  /** Replica: how far behind the primary it is, in ms. */
  lagMs?: number;
  /** Queue: age of the oldest waiting message, in ms. */
  oldestAgeMs?: number;
  /** Queue: messages finished by consumers per second. */
  processedPerSec?: number;
  /** Queue: messages given up on after too many failed deliveries (total). */
  deadLetters?: number;
  /** Database with a peer: local writes the peer has not confirmed yet. */
  unreplicated?: number;
  /** Database with a peer: writes overwritten by a conflicting write (total). */
  lostUpdates?: number;
  /** Server: a circuit breaker is open. */
  breakerOpen?: boolean;
  /** Load balancer: requests rejected by the rate limit per second. */
  limitedPerSec?: number;
  /** Server with autoscaling: workers still starting up. */
  booting?: number;
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

/** Traffic over one link, smoothed. */
export interface EdgeStats {
  /** Requests sent along the link per second. */
  perSec: number;
  /** Share of answers coming back along it that were failures. */
  errorRate: number;
}

export interface Snapshot {
  time: number;
  nodes: Record<string, NodeStats>;
  edges: Record<string, EdgeStats>;
  flights: Flight[];
  incidents: Incident[];
  /** Links currently cut by a network partition. */
  cutEdges: string[];
  /** Traffic multiplier from a scenario (1 = normal). */
  loadFactor?: number;
  /** The scenario running now, if any. */
  scenario?: { name: string; remainingMs: number } | null;
}

export type FaultAction =
  | { type: "crash"; nodeId: string }
  | { type: "recover"; nodeId: string }
  | { type: "slow"; nodeId: string; factor: number }
  | { type: "cut"; edgeIds: string[] }
  | { type: "heal"; edgeIds: string[] }
  /** Multiply every client's traffic (1 = normal). */
  | { type: "load"; factor: number }
  /** A named sequence of events, each after a delay in simulated time. */
  | { type: "scenario"; name: string; steps: { afterMs: number; action: FaultAction }[] }
  | { type: "endScenario" };
