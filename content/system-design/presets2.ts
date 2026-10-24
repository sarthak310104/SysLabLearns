import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ClientConfig, ComponentKind, DatabaseConfig, Graph, GraphNode, Snapshot } from "@/engine/model/types";
import { clientView, configOf, countKind, ofKind, targetsOf, type Preset } from "@/lib/goals";

function n(id: string, kind: ComponentKind, label: string, x: number, y: number, config: Partial<AnyConfig> = {}): GraphNode {
  return { id, kind, label, position: { x, y }, config: { ...defaultConfig(kind), ...config } as AnyConfig };
}
const e = (source: string, target: string) => ({ id: `e-${source}-${target}`, source, target });

/* ------------------------------------------------------------------ */
/* A4: databases and replication                                       */
/* ------------------------------------------------------------------ */

export const A4: Preset = {
  id: "a4-replication",
  title: "A read-heavy app with one database",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 120, { rps: 600, writeShare: 0.1, hotShare: 0.8 }),
      n("api", "server", "API server", 280, 100, { workers: 64, serviceMs: 3, queueLimit: 300 }),
      n("primary", "database", "Primary database", 580, 100, { workers: 8, serviceMs: 25 }),
    ],
    edges: [e("users", "api"), e("api", "primary")],
  },
  palette: ["replica"],
  goals: [
    {
      id: "add-replicas",
      text: "Add read replicas until 600 req/s are served with no errors.",
      hint: "Add a read replica, then make two links: API server to replica (reads go there) and primary to replica (it receives the writes). Each replica handles about 320 reads a second.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        return countKind(g, "replica") > 0 && c.sending >= 580 && c.active && c.errorRate < 0.005;
      },
    },
    {
      id: "lag",
      text: "Make a replica fall more than half a second behind, and watch stale reads appear.",
      hint: "Select Users and raise the share of writes to about 40%. Every replica has to apply every write, one at a time, while it's also busy serving reads.",
      holdMs: 1000,
      check: (s) => ofKind(s, "replica").some((r) => (r.lagMs ?? 0) > 500 && (r.staleRate ?? 0) > 0.02),
    },
    {
      id: "primary-down",
      text: "Crash the primary: reads keep working while every write fails.",
      hint: "Put writes back to around 10% first, so the replicas catch up. Then select the primary and crash it.",
      holdMs: 2000,
      check: (s) => {
        const c = clientView(s);
        const served = ofKind(s, "replica").reduce((a, r) => a + r.okPerSec, 0);
        return ofKind(s, "database").some((d) => d.down) && served > 100 && c.errorRate > 0.02 && c.errorRate < 0.6;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A5: sharding                                                        */
/* ------------------------------------------------------------------ */

const shardUtils = (s: Snapshot) => ofKind(s, "database").filter((d) => !d.down).map((d) => d.utilization);
const celebrity = (g: Graph) => Math.max(0, ...configOf<ClientConfig>(g, "client").map((c) => c.topKeyShare ?? 0));

export const A5: Preset = {
  id: "a5-sharding",
  title: "Too much data traffic for one database",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 140, { rps: 900, keySpace: 100000, hotShare: 0.2 }),
      n("api", "server", "API server", 250, 120, { workers: 128, serviceMs: 2, queueLimit: 500 }),
      n("router", "loadBalancer", "Shard router", 520, 120, { strategy: "keyHash" }),
      n("s1", "database", "Shard 1", 800, 20, { workers: 8, serviceMs: 25 }),
      n("s2", "database", "Shard 2", 800, 220, { workers: 8, serviceMs: 25 }),
    ],
    edges: [e("users", "api"), e("api", "router"), e("router", "s1"), e("router", "s2")],
  },
  palette: ["database", "cache"],
  goals: [
    {
      id: "enough-shards",
      text: "Add shards until 900 req/s are served with no errors.",
      hint: "Each shard handles about 320 req/s. Add databases and connect the shard router to each one.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        return countKind(g, "database") >= 3 && c.sending >= 850 && c.active && c.errorRate < 0.005;
      },
    },
    {
      id: "hot-shard",
      text: "Send 30% of traffic to one celebrity key and watch a single shard melt while the others idle.",
      hint: "Select Users and raise Traffic to one celebrity key.",
      holdMs: 2000,
      check: (s, g) => {
        const u = shardUtils(s);
        return celebrity(g) >= 0.25 && u.length >= 2 && Math.max(...u) > 0.95 && Math.min(...u) < 0.8;
      },
    },
    {
      id: "absorb-celebrity",
      text: "Keep the celebrity at 30% and get errors under 1%. Adding shards won't help.",
      hint: "The celebrity key always hashes to the same shard. Something in front of the router needs to answer it: add a cache between the API server and the router.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        return celebrity(g) >= 0.25 && c.sending >= 850 && c.active && c.errorRate < 0.01;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A6: queues and async work                                           */
/* ------------------------------------------------------------------ */

const consumers = (s: Snapshot, g: Graph) => targetsOf(g, "queue").map((id) => s.nodes[id]).filter(Boolean);
const backlog = (s: Snapshot) => Math.max(0, ...ofKind(s, "queue").map((q) => q.queue));

export const A6: Preset = {
  id: "a6-queues",
  title: "Slow uploads handled inline",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 80, { rps: 100 }),
      n("api", "server", "Upload API", 300, 60, { workers: 16, serviceMs: 200, queueLimit: 50 }),
    ],
    edges: [e("users", "api")],
  },
  palette: ["queue", "server"],
  goals: [
    {
      id: "go-async",
      text: "Move the 200 ms of work behind a queue: users get answers in under 50 ms at 100 req/s.",
      hint: "Add a queue and connect the Upload API to it. Add a server, name it Worker, set its work to 200 ms and connect the queue to it; add more workers if the queue grows. Finally, set the Upload API's own work to 5 ms: it now only hands work off.",
      holdMs: 5000,
      check: (s, g) => {
        const c = clientView(s);
        const slowConsumer = targetsOf(g, "queue").some((id) => {
          const cfg = g.nodes.find((x) => x.id === id)?.config as { serviceMs?: number } | undefined;
          return (cfg?.serviceMs ?? 0) >= 150;
        });
        return countKind(g, "queue") > 0 && slowConsumer && c.sending >= 95 && c.active && c.errorRate < 0.002 && c.p99 < 50;
      },
    },
    {
      id: "spike-drains",
      text: "Switch to spiky traffic: watch a backlog build during each spike and drain afterwards.",
      hint: "Select Users and set the traffic shape to Spikes. You need enough workers to keep up on average, not at the peak.",
      holdMs: 1000,
      check: (s, g, mem) => {
        const spiky = configOf<ClientConfig>(g, "client").some((c) => c.pattern === "spike");
        const b = backlog(s);
        if (spiky && b > 100) mem.built = true;
        return spiky && Boolean(mem.built) && b < 20;
      },
    },
    {
      id: "workers-down",
      text: "Crash every worker, then bring them back and let the backlog drain.",
      hint: "While the workers are down, users still get fast answers: the queue keeps accepting. That's the point of decoupling.",
      holdMs: 1000,
      check: (s, g, mem) => {
        const cs = consumers(s, g);
        if (cs.length && cs.every((c) => c.down) && backlog(s) > 200) mem.allDown = true;
        return Boolean(mem.allDown) && cs.length > 0 && cs.every((c) => !c.down) && backlog(s) < 50;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A7: timeouts, retries, load shedding and circuit breakers           */
/* ------------------------------------------------------------------ */

const dbSlow = (s: Snapshot, g: Graph) =>
  ofKind(s, "database").some((d) => d.slowFactor > 1) || configOf<DatabaseConfig>(g, "database").some((d) => d.serviceMs >= 45);
const success = (s: Snapshot) => 1 - clientView(s).errorRate;

export const A7: Preset = {
  id: "a7-resilience",
  title: "Impatient clients and a database that slows down",
  graph: {
    nodes: [
      n("users", "client", "Users", 0, 100, { rps: 200, timeoutMs: 1000, retries: 3, backoff: "none" }),
      n("api", "server", "API server", 280, 80, { workers: 32, serviceMs: 5, queueLimit: 200 }),
      n("db", "database", "Database", 560, 80, { workers: 8, serviceMs: 25 }),
    ],
    edges: [e("users", "api"), e("api", "db")],
  },
  palette: [],
  goals: [
    {
      id: "collapse",
      text: "Double the database's work per query and watch almost nothing succeed, while retries multiply the load.",
      hint: "Select the database and set Work per query to 50 ms. It can still serve about 160 req/s, so why does almost everything fail?",
      holdMs: 2000,
      check: (s, g) => dbSlow(s, g) && clientView(s).active && success(s) < 0.2 && clientView(s).amplification > 2,
    },
    {
      id: "shed",
      text: "With the database still slow, get at least 60% of requests succeeding again.",
      hint: "Requests sit in the API server's queue of 200 for longer than users will wait, so the database works on answers nobody wants. Shorten that queue to about 20: rejecting early is kinder than answering late.",
      holdMs: 5000,
      check: (s, g) => dbSlow(s, g) && clientView(s).sending >= 190 && success(s) >= 0.6,
    },
    {
      id: "budget",
      text: "Keep retries switched on, but stop them piling on: load under 1.3x what users send, success still above 60%.",
      hint: "Open Users' timeouts and retries and set a retry budget of about 10%. Retries still smooth over blips, but can't multiply an outage.",
      holdMs: 5000,
      check: (s, g) => {
        const retrying = configOf<ClientConfig>(g, "client").some((c) => c.retries >= 1);
        return dbSlow(s, g) && retrying && success(s) >= 0.6 && clientView(s).amplification < 1.3;
      },
    },
    {
      id: "hang",
      text: "Cut the network between the API server and the database, and keep the API server from freezing.",
      hint: "Over a cut link, calls never get an answer, so without a timeout every worker waits forever. Give the API server a downstream timeout of about 300 ms and turn on its circuit breaker.",
      holdMs: 3000,
      check: (s, g) => {
        const cutToDb = g.edges.some((x) => x.source === "api" && s.cutEdges.includes(x.id));
        const servers = ofKind(s, "server");
        return cutToDb && servers.every((a) => a.busy < a.workers * 0.5 && a.queue < 20);
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* A8: consistency and partitions                                      */
/* ------------------------------------------------------------------ */

const dbLinkCut = (s: Snapshot, g: Graph) => {
  const dbs = new Set(g.nodes.filter((x) => x.kind === "database").map((x) => x.id));
  return g.edges.some((x) => dbs.has(x.source) && dbs.has(x.target) && s.cutEdges.includes(x.id));
};
const lost = (s: Snapshot) => ofKind(s, "database").reduce((a, d) => a + (d.lostUpdates ?? 0), 0);

export const A8: Preset = {
  id: "a8-partitions",
  title: "Two regions, one dataset",
  graph: {
    nodes: [
      n("eu", "client", "Users in Europe", 0, 0, { rps: 150, writeShare: 0.3, keySpace: 1000, hotShare: 0.5 }),
      n("euApi", "server", "API (Europe)", 260, -20, { workers: 32, serviceMs: 3 }),
      n("euDb", "database", "Database (Europe)", 540, -20, { workers: 16, serviceMs: 10, mode: "async" }),
      n("us", "client", "Users in America", 0, 280, { rps: 150, writeShare: 0.3, keySpace: 1000, hotShare: 0.5 }),
      n("usApi", "server", "API (America)", 260, 260, { workers: 32, serviceMs: 3 }),
      n("usDb", "database", "Database (America)", 540, 260, { workers: 16, serviceMs: 10, mode: "async" }),
    ],
    edges: [e("eu", "euApi"), e("euApi", "euDb"), e("us", "usApi"), e("usApi", "usDb"), e("euDb", "usDb"), e("usDb", "euDb")],
  },
  palette: [],
  goals: [
    {
      id: "available",
      text: "Cut the network between the regions. Both keep accepting writes, and their data starts to drift apart.",
      hint: "Select one of the links between the two databases and cut it. Watch Not yet synced climb.",
      holdMs: 2000,
      check: (s, g) => {
        const cs = ofKind(s, "client");
        return dbLinkCut(s, g) && cs.every((c) => c.errorRate < 0.01) && ofKind(s, "database").some((d) => (d.unreplicated ?? 0) > 20);
      },
    },
    {
      id: "conflicts",
      text: "Reconnect the regions and find out what the partition cost: count the lost updates.",
      hint: "Select the cut link and reconnect it. Writes to the same key on both sides can't both win.",
      holdMs: 1000,
      check: (s, g, mem) => {
        if (dbLinkCut(s, g)) mem.wasCut = true;
        return Boolean(mem.wasCut) && !dbLinkCut(s, g) && lost(s) > 0;
      },
    },
    {
      id: "consistent",
      text: "Switch both databases to consistent mode and cut the link again: now writes fail instead of drifting.",
      hint: "Select each database and choose Consistent. Notice every write gets slower even before the cut: it waits for the other region.",
      holdMs: 2000,
      check: (s, g) => {
        const allSync = configOf<DatabaseConfig>(g, "database").every((d) => d.mode === "sync");
        const failing = ofKind(s, "client").some((c) => c.errorRate > 0.15);
        const drifting = ofKind(s, "database").some((d) => (d.unreplicated ?? 0) > 5);
        return allSync && dbLinkCut(s, g) && failing && !drifting;
      },
    },
  ],
};
