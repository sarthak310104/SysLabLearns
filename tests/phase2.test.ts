import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import type { FaultAction, Graph, Snapshot } from "@/engine/model/types";
import { edge, node } from "./helpers";

/** Run with optional scripted actions at given times; returns the last snapshot and a peak tracker. */
function script(graph: Graph, ms: number, actions: Record<number, (sim: Simulation) => void> = {}, seed = 9) {
  const sim = new Simulation(graph, seed);
  let snap: Snapshot = sim.snapshot();
  const peaks: Record<string, number> = {};
  for (let t = 100; t <= ms; t += 100) {
    sim.runUntil(t);
    actions[t]?.(sim);
    snap = sim.snapshot();
    for (const n of Object.values(snap.nodes)) {
      peaks[`${n.id}.queue`] = Math.max(peaks[`${n.id}.queue`] ?? 0, n.queue);
      peaks[`${n.id}.lag`] = Math.max(peaks[`${n.id}.lag`] ?? 0, n.lagMs ?? 0);
    }
  }
  return { sim, snap, peaks };
}
const fault = (a: FaultAction) => (sim: Simulation) => sim.applyFault(a);

describe("A4 replication", () => {
  const graph = (replicas: number): Graph => ({
    nodes: [
      node("c", "client", { rps: 600, writeShare: 0.1, hotShare: 0.8 }),
      node("api", "server", { workers: 64, serviceMs: 3, queueLimit: 300 }),
      node("db", "database", { workers: 8, serviceMs: 25 }),
      ...Array.from({ length: replicas }, (_, i) => node(`r${i}`, "replica", { workers: 8, serviceMs: 25 })),
    ],
    edges: [
      edge("c", "api"),
      edge("api", "db"),
      ...Array.from({ length: replicas }, (_, i) => edge("api", `r${i}`)),
      ...Array.from({ length: replicas }, (_, i) => edge("db", `r${i}`)),
    ],
  });

  it("the primary alone can't keep up with reads", () => {
    const { snap } = script(graph(0), 10000);
    expect(snap.nodes.c.errorRate).toBeGreaterThan(0.05);
  });

  it("two replicas absorb the reads; writes still go to the primary", () => {
    const { snap } = script(graph(2), 15000);
    expect(snap.nodes.c.errorRate).toBeLessThan(0.005);
    expect(snap.nodes.r0.okPerSec).toBeGreaterThan(200);
    expect(snap.nodes.db.okPerSec).toBeGreaterThan(40);
    expect(snap.nodes.db.okPerSec).toBeLessThan(90);
  });

  it("with heavy writes, replicas fall behind and serve stale reads", () => {
    const moreWrites = (sim: Simulation) => {
      const c = node("c", "client", { rps: 600, writeShare: 0.4, hotShare: 0.8 });
      sim.updateConfig("c", c.config);
    };
    const before = script(graph(2), 6000).snap;
    const { snap, peaks } = script(graph(2), 20000, { 5000: moreWrites });
    expect(before.nodes.r0.lagMs!).toBeLessThan(100);
    expect(peaks["r0.lag"]).toBeGreaterThan(500);
    expect(snap.nodes.r0.staleRate!).toBeGreaterThan(0.05);
  });

  it("with the primary down, reads keep working and writes fail", () => {
    const { snap } = script(graph(2), 12000, { 5000: fault({ type: "crash", nodeId: "db" }) });
    expect(snap.nodes.c.errorRate).toBeGreaterThan(0.05);
    expect(snap.nodes.c.errorRate).toBeLessThan(0.2);
    expect(snap.nodes.r0.okPerSec).toBeGreaterThan(200);
  });
});

describe("A5 sharding", () => {
  const graph = (shards: number, topKeyShare = 0, cache = false): Graph => ({
    nodes: [
      node("c", "client", { rps: 900, keySpace: 100000, hotShare: 0.2, topKeyShare }),
      node("api", "server", { workers: 128, serviceMs: 2, queueLimit: 500 }),
      ...(cache ? [node("k", "cache", { capacity: 2000, ttlMs: 30000 })] : []),
      node("router", "loadBalancer", { strategy: "keyHash" } as never),
      ...Array.from({ length: shards }, (_, i) => node(`s${i}`, "database", { workers: 8, serviceMs: 25 })),
    ],
    edges: [
      edge("c", "api"),
      ...(cache ? [edge("api", "k"), edge("k", "router")] : [edge("api", "router")]),
      ...Array.from({ length: shards }, (_, i) => edge("router", `s${i}`)),
    ],
  });

  it("two shards are not enough; four are", () => {
    expect(script(graph(2), 10000).snap.nodes.c.errorRate).toBeGreaterThan(0.05);
    expect(script(graph(4), 15000).snap.nodes.c.errorRate).toBeLessThan(0.005);
  });

  it("a celebrity key melts one shard, and more shards don't help", () => {
    const four = script(graph(4, 0.3), 15000).snap;
    const utils = [0, 1, 2, 3].map((i) => four.nodes[`s${i}`].utilization).sort();
    expect(four.nodes.c.errorRate).toBeGreaterThan(0.02);
    expect(utils[3]).toBeGreaterThan(0.95);
    expect(utils[0]).toBeLessThan(0.8);
    expect(script(graph(8, 0.3), 15000).snap.nodes.c.errorRate).toBeGreaterThan(0.02);
  });

  it("a cache in front of the router absorbs the celebrity", () => {
    expect(script(graph(4, 0.3, true), 15000).snap.nodes.c.errorRate).toBeLessThan(0.01);
  });
});

describe("A6 queues", () => {
  const sync: Graph = {
    nodes: [node("c", "client", { rps: 100 }), node("api", "server", { workers: 16, serviceMs: 200, queueLimit: 50 })],
    edges: [edge("c", "api")],
  };
  const queued = (workers: number, pattern = "steady"): Graph => ({
    nodes: [
      node("c", "client", { rps: 100, pattern } as never),
      node("api", "server", { workers: 16, serviceMs: 5 }),
      node("q", "queue", { capacity: 5000 }),
      ...Array.from({ length: workers }, (_, i) => node(`w${i}`, "server", { workers: 8, serviceMs: 200 })),
    ],
    edges: [edge("c", "api"), edge("api", "q"), ...Array.from({ length: workers }, (_, i) => edge("q", `w${i}`))],
  });

  it("doing slow work inline overloads the API", () => {
    expect(script(sync, 10000).snap.nodes.c.errorRate).toBeGreaterThan(0.05);
  });

  it("a queue makes the API fast and the workers keep up", () => {
    const { snap } = script(queued(3), 15000);
    expect(snap.nodes.c.p99).toBeLessThan(50);
    expect(snap.nodes.c.errorRate).toBe(0);
    expect(snap.nodes.q.processedPerSec!).toBeGreaterThan(80);
    expect(snap.nodes.q.queue).toBeLessThan(50);
  });

  it("spikes build a backlog that drains afterwards", () => {
    const { snap, peaks } = script(queued(3, "spike"), 30000);
    expect(peaks["q.queue"]).toBeGreaterThan(100);
    expect(snap.nodes.q.queue).toBeLessThan(peaks["q.queue"]);
  });

  it("if every worker crashes, users still get answers and the backlog waits", () => {
    const crashAll: Record<number, (s: Simulation) => void> = {
      3000: (s) => ["w0", "w1", "w2"].forEach((id) => s.applyFault({ type: "crash", nodeId: id })),
      10000: (s) => ["w0", "w1", "w2"].forEach((id) => s.applyFault({ type: "recover", nodeId: id })),
    };
    const during = script(queued(3), 9000, crashAll).snap;
    expect(during.nodes.c.errorRate).toBe(0);
    expect(during.nodes.q.queue).toBeGreaterThan(400);
    // Spare capacity is only 20 msg/s, so the backlog drains slowly: that's the lesson.
    const later = script(queued(3), 20000, crashAll).snap;
    const after = script(queued(3), 60000, crashAll).snap;
    expect(later.nodes.q.queue).toBeLessThan(during.nodes.q.queue + 200);
    expect(after.nodes.q.queue).toBeLessThan(50);
  });
});

describe("A7 timeouts, retries and breakers", () => {
  const graph = (opts: { retries: number; backoff: string; apiTimeout: number; breaker: boolean }): Graph => ({
    nodes: [
      node("c", "client", { rps: 200, timeoutMs: 1000, retries: opts.retries, backoff: opts.backoff } as never),
      node("api", "server", { workers: 32, serviceMs: 5, queueLimit: 200, timeoutMs: opts.apiTimeout, breaker: opts.breaker }),
      node("db", "database", { workers: 8, serviceMs: 25 }),
    ],
    edges: [edge("c", "api"), edge("api", "db")],
  });
  const slowDb = { 3000: fault({ type: "slow", nodeId: "db", factor: 4 }) };

  it("healthy: no retries needed", () => {
    const { snap } = script(graph({ retries: 3, backoff: "none", apiTimeout: 0, breaker: false }), 8000);
    expect(snap.nodes.c.errorRate).toBe(0);
    expect(snap.nodes.c.attemptsPerSec! / snap.nodes.c.sendingRps!).toBeLessThan(1.1);
  });

  it("a slow database plus eager retries makes a retry storm", () => {
    const { snap } = script(graph({ retries: 3, backoff: "none", apiTimeout: 0, breaker: false }), 15000, slowDb);
    expect(snap.nodes.c.attemptsPerSec! / snap.nodes.c.sendingRps!).toBeGreaterThan(2);
  });

  it("over a cut link, a timeout plus breaker keeps workers free; without them they hang", () => {
    const cut = { 3000: fault({ type: "cut", edgeIds: ["c->api".replace("c->api", "api->db")] }) };
    const hung = script(graph({ retries: 0, backoff: "none", apiTimeout: 0, breaker: false }), 8000, cut).snap;
    const guarded = script(graph({ retries: 0, backoff: "none", apiTimeout: 300, breaker: true }), 8000, cut).snap;
    expect(hung.nodes.api.busy).toBe(32);
    expect(guarded.nodes.api.busy).toBeLessThan(16);
  });
});

describe("A8 partitions", () => {
  const graph = (mode: "async" | "sync"): Graph => ({
    nodes: [
      node("eu", "client", { rps: 150, writeShare: 0.3, keySpace: 1000, hotShare: 0.5 }),
      node("us", "client", { rps: 150, writeShare: 0.3, keySpace: 1000, hotShare: 0.5 }),
      node("euApi", "server", { workers: 32, serviceMs: 3 }),
      node("usApi", "server", { workers: 32, serviceMs: 3 }),
      node("euDb", "database", { workers: 16, serviceMs: 10, mode }),
      node("usDb", "database", { workers: 16, serviceMs: 10, mode }),
    ],
    edges: [
      edge("eu", "euApi"),
      edge("us", "usApi"),
      edge("euApi", "euDb"),
      edge("usApi", "usDb"),
      edge("euDb", "usDb"),
      edge("usDb", "euDb"),
    ],
  });
  const both = ["euDb->usDb", "usDb->euDb"];

  it("available mode: both sides keep writing, then conflicts surface on heal", () => {
    const during = script(graph("async"), 8000, { 3000: fault({ type: "cut", edgeIds: both }) }).snap;
    expect(during.nodes.eu.errorRate).toBeLessThan(0.01);
    expect(during.nodes.euDb.unreplicated!).toBeGreaterThan(20);
    const after = script(graph("async"), 14000, {
      3000: fault({ type: "cut", edgeIds: both }),
      8000: fault({ type: "heal", edgeIds: both }),
    }).snap;
    expect(after.nodes.euDb.unreplicated!).toBeLessThan(20);
    expect((after.nodes.euDb.lostUpdates ?? 0) + (after.nodes.usDb.lostUpdates ?? 0)).toBeGreaterThan(0);
  });

  it("consistent mode: writes fail during the partition instead of diverging", () => {
    const healthy = script(graph("sync"), 6000).snap;
    expect(healthy.nodes.eu.errorRate).toBe(0);
    expect(healthy.nodes.eu.p99).toBeGreaterThan(80); // every write waits for the other region
    const during = script(graph("sync"), 10000, { 3000: fault({ type: "cut", edgeIds: both }) }).snap;
    expect(during.nodes.eu.errorRate).toBeGreaterThan(0.15);
    expect(during.nodes.euDb.unreplicated ?? 0).toBe(0);
  });
});
