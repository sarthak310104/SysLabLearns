import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ClientConfig, ComponentKind, Graph, GraphNode, LoadBalancerConfig, Region, ServerConfig, Snapshot } from "@/engine/model/types";
import { clientView, configOf, countKind, ofKind, type Preset } from "@/lib/goals";

function n(id: string, kind: ComponentKind, label: string, x: number, y: number, config: Partial<AnyConfig> = {}, region?: Region): GraphNode {
  return { id, kind, label, position: { x, y }, config: { ...defaultConfig(kind), ...config } as AnyConfig, ...(region ? { region } : {}) };
}
const e = (source: string, target: string) => ({ id: `e-${source}-${target}`, source, target });

/* ------------------------------------------------------------------ */
/* A9: CDNs and network latency                                        */
/* ------------------------------------------------------------------ */

export const A9: Preset = {
  id: "a9-cdn",
  title: "Users in Mumbai, servers in Virginia",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 80, { rps: 300, keySpace: 5000, hotShare: 0.9 }, "mumbai"),
      n("origin", "server", "Origin web server", 420, 60, { workers: 32, serviceMs: 10 }, "virginia"),
      n("db", "database", "Origin database", 720, 60, { workers: 8, serviceMs: 15 }, "virginia"),
    ],
    edges: [e("users", "origin"), e("origin", "db")],
  },
  palette: ["cache"],
  goals: [
    {
      id: "distance",
      text: "Send traffic and notice where the time goes: a typical request takes over 180 ms, almost all of it travel.",
      hint: "The server and database together take about 25 ms. Mumbai to Virginia is about 95 ms each way.",
      holdMs: 2000,
      check: (s) => ofKind(s, "client").some((c) => c.p50 > 180),
    },
    {
      id: "edge",
      text: "Put a CDN cache in Mumbai so a typical request takes under 20 ms.",
      hint: "Add a cache, set its region to Mumbai, then connect Users to the cache and the cache to the origin web server. Remove the direct Users to origin link.",
      holdMs: 5000,
      check: (s, g) => {
        const edgeCache = g.nodes.some((x) => x.kind === "cache" && x.region === "mumbai");
        const c = ofKind(s, "client")[0];
        return edgeCache && Boolean(c) && c.p50 < 20 && c.errorRate < 0.01 && c.okPerSec > 200;
      },
    },
    {
      id: "shield",
      text: "Crash the origin web server: the CDN keeps most users served.",
      hint: "Popular content is already sitting in the CDN, so it doesn't need the origin until it expires.",
      holdMs: 3000,
      check: (s, g) => {
        const originDown = ofKind(s, "server").some((x) => x.down);
        return countKind(g, "cache") > 0 && originDown && 1 - clientView(s).errorRate >= 0.7 && clientView(s).active;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A10: consistent hashing and rebalancing                             */
/* ------------------------------------------------------------------ */

const routerOf = (g: Graph) => configOf<LoadBalancerConfig>(g, "loadBalancer")[0];
const db = (s: Snapshot) => ofKind(s, "database")[0];
const flooded = (s: Snapshot) => {
  const d = db(s);
  return Boolean(d) && (d.errorRate > 0.05 || d.utilization > 0.97);
};

export const A10: Preset = {
  id: "a10-consistent-hashing",
  title: "A sharded cache in front of one database",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 250, { rps: 2000, keySpace: 8000, hotShare: 0.3 }),
      n("api", "server", "API server", 230, 230, { workers: 128, serviceMs: 1, queueLimit: 500 }),
      n("router", "loadBalancer", "Cache router", 470, 230, { strategy: "keyHash" }),
      n("c1", "cache", "Cache shard 1", 720, 0, { capacity: 5000, ttlMs: 600000 }),
      n("c2", "cache", "Cache shard 2", 720, 150, { capacity: 5000, ttlMs: 600000 }),
      n("c3", "cache", "Cache shard 3", 720, 300, { capacity: 5000, ttlMs: 600000 }),
      n("c4", "cache", "Cache shard 4", 720, 450, { capacity: 5000, ttlMs: 600000 }),
      n("db", "database", "Database", 1000, 230, { workers: 16, serviceMs: 20, queueLimit: 300 }),
    ],
    edges: [
      e("users", "api"),
      e("api", "router"),
      ...["c1", "c2", "c3", "c4"].flatMap((c) => [e("router", c), e(c, "db")]),
    ],
  },
  palette: ["cache"],
  goals: [
    {
      id: "mod-n-storm",
      text: "Let the caches warm up, then add a fifth shard while the router uses hash mod N. Watch the database get flooded.",
      hint: "Wait until the database is calm. Add a cache, connect the router to it and it to the database. Most keys now map to a different shard, which doesn't have them.",
      holdMs: 0,
      check: (s, g, mem) => {
        const count = countKind(g, "cache");
        const prev = (mem.count as number | undefined) ?? count;
        mem.count = count;
        if (count > prev && routerOf(g)?.strategy === "keyHash" && s.time > 10000) mem.addedAt = s.time;
        const added = mem.addedAt as number | undefined;
        return added !== undefined && s.time - added < 10000 && flooded(s);
      },
    },
    {
      id: "ring-add",
      text: "Switch the router to consistent hashing, let it settle, then add another shard: the database should barely notice.",
      hint: "Changing the routing scheme itself moves keys, so wait for the database to calm down first. Then add a shard the same way as before.",
      holdMs: 0,
      check: (s, g, mem) => {
        const count = countKind(g, "cache");
        const prev = (mem.count as number | undefined) ?? count;
        mem.count = count;
        if (count > prev && routerOf(g)?.strategy === "consistentHash") {
          mem.addedAt = s.time;
          mem.bad = flooded(s);
        }
        const added = mem.addedAt as number | undefined;
        if (added === undefined) return false;
        const d = db(s);
        if (s.time - added < 8000 && d && d.errorRate > 0.02) mem.bad = true;
        return s.time - added >= 8000 && !mem.bad;
      },
    },
    {
      id: "ring-failover",
      text: "With consistent hashing and health checks, crash a cache shard: only its keys move, and nothing fails.",
      hint: "Turn on health checks on the router. A dead shard's keys go to the next shard round the ring, which fetches them from the database once.",
      holdMs: 5000,
      check: (s, g) => {
        const r = routerOf(g);
        const anyDown = ofKind(s, "cache").some((c) => c.down);
        const d = db(s);
        return r?.strategy === "consistentHash" && r.healthChecks && anyDown && clientView(s).errorRate < 0.01 && Boolean(d) && d.utilization < 0.9;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A11: rate limiting and noisy neighbours                             */
/* ------------------------------------------------------------------ */

const errorRateOf = (s: Snapshot, id: string) => s.nodes[id]?.errorRate ?? 0;

export const A11: Preset = {
  id: "a11-rate-limiting",
  title: "One partner's script floods a shared API",
  graph: {
    nodes: [
      n("users", "client", "Normal users", 0, 0, { rps: 200 }),
      n("partner", "client", "Partner's buggy script", 0, 220, { rps: 600 }),
      n("gateway", "loadBalancer", "API gateway", 290, 110, { strategy: "roundRobin" }),
      n("s1", "server", "Server 1", 570, 20, { workers: 8, serviceMs: 30 }),
      n("s2", "server", "Server 2", 570, 200, { workers: 8, serviceMs: 30 }),
    ],
    edges: [e("users", "gateway"), e("partner", "gateway"), e("gateway", "s1"), e("gateway", "s2")],
  },
  palette: [],
  goals: [
    {
      id: "noisy",
      text: "Send traffic: the partner's script hurts normal users too.",
      hint: "The servers can handle about 530 req/s between them. Normal users send 200 and the script sends 600.",
      holdMs: 2000,
      check: (s) => errorRateOf(s, "users") > 0.1,
    },
    {
      id: "global-limit",
      text: "Add a rate limit for everyone together: the servers are protected, but normal users still lose out.",
      hint: "Select the API gateway, open More settings, and set a rate limit of about 450 req/s for everyone together.",
      holdMs: 3000,
      check: (s, g) => {
        const gw = routerOf(g);
        const calm = ofKind(s, "server").every((x) => x.queue < x.queueLimit * 0.5);
        return Boolean(gw) && gw.rateLimit > 0 && gw.rateLimitScope === "global" && calm && errorRateOf(s, "users") > 0.1;
      },
    },
    {
      id: "per-client",
      text: "Make the limit apply to each client separately: normal users get through and only the script is throttled.",
      hint: "Switch the limit to each client separately, and pick a number above what normal users need but well below what the script sends.",
      holdMs: 5000,
      check: (s, g) => {
        const gw = routerOf(g);
        return Boolean(gw) && gw.rateLimitScope === "perClient" && errorRateOf(s, "users") < 0.01 && errorRateOf(s, "partner") > 0.2 && (s.nodes.users?.okPerSec ?? 0) > 150;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A12: autoscaling                                                    */
/* ------------------------------------------------------------------ */

const usersCfg = (g: Graph) => configOf<ClientConfig>(g, "client")[0];
const webCfg = (g: Graph) => configOf<ServerConfig>(g, "server")[0];

export const A12: Preset = {
  id: "a12-autoscaling",
  title: "A web tier that grows and shrinks",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 60, { rps: 100 }),
      n("web", "server", "Web servers", 300, 40, { workers: 6, serviceMs: 40, queueLimit: 200, autoscale: false, maxWorkers: 96, bootSeconds: 10 }),
    ],
    edges: [e("users", "web")],
  },
  palette: [],
  goals: [
    {
      id: "ramp",
      text: "Turn on autoscaling, then ramp traffic up to 400 req/s: the web tier grows with it and nothing fails.",
      hint: "Select Web servers and turn on Autoscaling. Then select Users, set the traffic shape to Ramp and the rate to 400.",
      holdMs: 5000,
      check: (s, g) => {
        const u = usersCfg(g);
        const c = clientView(s);
        return Boolean(webCfg(g)?.autoscale) && u?.pattern === "ramp" && c.sending >= 380 && c.active && c.errorRate < 0.01;
      },
    },
    {
      id: "too-slow",
      text: "Switch to sudden spikes: autoscaling can't start workers in time.",
      hint: "Spikes last 2 seconds; new workers take 10 seconds to start.",
      holdMs: 0,
      check: (s, g) => Boolean(webCfg(g)?.autoscale) && usersCfg(g)?.pattern === "spike" && clientView(s).errorRate > 0.05,
    },
    {
      id: "headroom",
      text: "Keep the spikes, and get through them with under 1% errors.",
      hint: "Autoscaling can't help with something shorter than its start-up time. Keep spare capacity running all the time: raise the minimum number of workers.",
      holdMs: 12000,
      check: (s, g) => usersCfg(g)?.pattern === "spike" && (usersCfg(g)?.rps ?? 0) >= 380 && clientView(s).active && clientView(s).errorRate < 0.01,
    },
  ],
};

