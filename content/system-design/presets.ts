import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, GraphNode } from "@/engine/model/types";
import { clientView, countKind, ofKind, type Preset } from "@/lib/goals";

function n(id: string, kind: ComponentKind, label: string, x: number, y: number, config: Partial<AnyConfig> = {}): GraphNode {
  return { id, kind, label, position: { x, y }, config: { ...defaultConfig(kind), ...config } as AnyConfig };
}
const e = (source: string, target: string) => ({ id: `e-${source}-${target}`, source, target });

/* ------------------------------------------------------------------ */
/* A1: requests, latency, throughput                                   */
/* ------------------------------------------------------------------ */

const a1Graph: Graph = {
  nodes: [
    n("users", "client", "Users", 0, 40, { rps: 30 }),
    n("api", "server", "API server", 300, 20, { workers: 4, serviceMs: 40, queueLimit: 100 }),
  ],
  edges: [e("users", "api")],
};

export const A1: Preset = {
  id: "a1-one-server",
  title: "One server, rising load",
  graph: a1Graph,
  palette: [],
  goals: [
    {
      id: "near-capacity",
      text: "Raise the load to 90 req/s and watch the slowest 1% climb past 300 ms.",
      hint: "Select Users and drag Requests per second to 90. The server's capacity is about 100 req/s.",
      holdMs: 2000,
      check: (s) => {
        const c = clientView(s);
        return c.sending >= 85 && c.p99 > 300;
      },
    },
    {
      id: "overload",
      text: "Push past capacity until the server starts rejecting requests.",
      hint: "Go above 100 req/s and give the queue a few seconds to fill.",
      holdMs: 1000,
      check: (s) => ofKind(s, "server").some((x) => x.errorsPerSec > 0 && x.queue >= x.queueLimit * 0.8),
    },
    {
      id: "scale-up",
      text: "Serve 180 req/s with no errors and p99 under 200 ms.",
      hint: "Select the API server and add workers. Each worker handles about 25 req/s at 40 ms per request, but leave headroom.",
      holdMs: 5000,
      check: (s) => {
        const c = clientView(s);
        return c.sending >= 175 && c.active && c.errorRate < 0.002 && c.p99 < 200;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A2: load balancing                                                  */
/* ------------------------------------------------------------------ */

const a2Graph: Graph = {
  nodes: [
    n("users", "client", "Users", 0, 130, { rps: 220 }),
    n("lb", "loadBalancer", "Load balancer", 280, 130, { strategy: "roundRobin", healthChecks: false }),
    n("s1", "server", "Server 1", 560, 0, { workers: 4, serviceMs: 40 }),
    n("s2", "server", "Server 2", 560, 150, { workers: 4, serviceMs: 40 }),
    n("s3", "server", "Server 3 (old)", 560, 300, { workers: 4, serviceMs: 90 }),
  ],
  edges: [e("users", "lb"), e("lb", "s1"), e("lb", "s2"), e("lb", "s3")],
};

const anyServerDown = (s: Parameters<typeof clientView>[0]) => ofKind(s, "server").some((x) => x.down);

export const A2: Preset = {
  id: "a2-balancing",
  title: "Three servers, one of them old",
  graph: a2Graph,
  palette: ["server"],
  goals: [
    {
      id: "fair-not-equal",
      text: "Get errors to zero at 220 req/s without adding servers.",
      hint: "Round robin sends the old server as much as the fast ones. Try a strategy that looks at how busy each server is.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        return countKind(g, "server") <= 3 && c.sending >= 200 && c.active && c.errorRate < 0.005;
      },
    },
    {
      id: "blind-balancer",
      text: "Turn health checks off, crash a server, and watch requests keep going to it.",
      hint: "Select the load balancer to check health checks are off, then select a server and crash it.",
      holdMs: 2000,
      check: (s, g) => {
        const lbs = g.nodes.filter((x) => x.kind === "loadBalancer");
        const blind = lbs.some((x) => !(x.config as { healthChecks: boolean }).healthChecks);
        return blind && anyServerDown(s) && clientView(s).errorRate > 0.15;
      },
    },
    {
      id: "survive-crash",
      text: "With a server down, still serve 220 req/s with under 1% errors.",
      hint: "Health checks stop traffic going to dead servers, but the survivors need enough capacity. Add a server.",
      holdMs: 5000,
      check: (s) => {
        const c = clientView(s);
        return anyServerDown(s) && c.sending >= 200 && c.active && c.errorRate < 0.01;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A3: caching                                                         */
/* ------------------------------------------------------------------ */

const a3Graph: Graph = {
  nodes: [
    n("users", "client", "Users", 0, 60, { rps: 400, keySpace: 10000, hotShare: 0.8 }),
    n("api", "server", "API server", 280, 40, { workers: 32, serviceMs: 5, queueLimit: 200 }),
    n("db", "database", "Database", 820, 40, { workers: 8, serviceMs: 25, queueLimit: 200 }),
  ],
  edges: [e("users", "api"), e("api", "db")],
};

export const A3: Preset = {
  id: "a3-cache",
  title: "A busy read path",
  graph: a3Graph,
  palette: ["cache"],
  goals: [
    {
      id: "find-bottleneck",
      text: "Send traffic and find which component is the bottleneck.",
      hint: "Look for the Bottleneck label. Notice the API server also looks unhealthy: it's waiting on something else.",
      holdMs: 3000,
      check: (s) => ofKind(s, "database").some((x) => x.bottleneck),
    },
    {
      id: "add-cache",
      text: "Put a cache between the API server and the database: no errors and p99 under 120 ms.",
      hint: "Add a cache, connect API server to cache and cache to database, then select the old API-to-database wire and press Delete.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        return countKind(g, "cache") > 0 && c.sending >= 380 && c.active && c.errorRate < 0.005 && c.p99 < 120;
      },
    },
    {
      id: "cold-cache",
      text: "Crash the cache, bring it back, and watch it warm up to a 60% hit ratio.",
      hint: "A restarted cache is empty. Every request misses until the hot keys are loaded again.",
      holdMs: 2000,
      check: (s, _g, mem) => {
        const caches = ofKind(s, "cache");
        if (caches.some((x) => x.down)) mem.crashed = true;
        return Boolean(mem.crashed) && caches.some((x) => !x.down && (x.hitRatio ?? 0) > 0.6);
      },
    },
  ],
};

export const PRESETS: Record<string, Preset> = Object.fromEntries([A1, A2, A3].map((p) => [p.id, p]));
