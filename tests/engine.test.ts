import { describe, expect, it } from "vitest";
import { EventQueue } from "@/engine/core/eventQueue";
import { Rng } from "@/engine/core/rng";
import { Simulation } from "@/engine/model/simulation";
import type { Incident } from "@/engine/model/types";
import { edge, node, run } from "./helpers";

describe("core", () => {
  it("event queue pops in time order, ties in insertion order", () => {
    const q = new EventQueue<string>();
    q.push(5, "c");
    q.push(1, "a");
    q.push(5, "d");
    q.push(2, "b");
    const out: string[] = [];
    while (q.size) out.push(q.pop()!.event);
    expect(out).toEqual(["a", "b", "c", "d"]);
  });

  it("rng is deterministic per seed", () => {
    const a = new Rng(3);
    const b = new Rng(3);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });
});

describe("single server", () => {
  const graph = (rps: number, workers = 4) => ({
    nodes: [node("c", "client", { rps }), node("s", "server", { workers, serviceMs: 40, queueLimit: 100 })],
    edges: [edge("c", "s")],
  });

  it("serves everything when load is below capacity", () => {
    const { snap } = run(graph(50), 10000);
    expect(snap.nodes.c.errorRate).toBe(0);
    expect(snap.nodes.c.okPerSec).toBeGreaterThan(35);
    expect(snap.nodes.c.okPerSec).toBeLessThan(65);
    expect(snap.nodes.s.utilization).toBeGreaterThan(0.35);
    expect(snap.nodes.s.utilization).toBeLessThan(0.65);
  });

  it("rejects requests once the queue fills above capacity", () => {
    const { snap } = run(graph(160), 10000);
    expect(snap.nodes.s.errorsPerSec).toBeGreaterThan(20);
    expect(snap.nodes.s.status).toBe("critical");
    expect(snap.nodes.s.bottleneck).toBe(true);
  });

  it("latency climbs as utilization approaches 1", () => {
    const low = run(graph(30), 15000).snap.nodes.c.p99;
    const high = run(graph(92), 15000).snap.nodes.c.p99;
    expect(high).toBeGreaterThan(low * 2);
  });

  it("is deterministic for the same seed", () => {
    const a = run(graph(80), 5000, 11).snap.nodes.c;
    const b = run(graph(80), 5000, 11).snap.nodes.c;
    expect(a).toEqual(b);
  });

  it("a crashed server fails requests and reports an incident", () => {
    const incidents: Incident[] = [];
    run(graph(50), 4000, 1, (sim, s) => {
      if (Math.round(sim.now) === 2000) sim.applyFault({ type: "crash", nodeId: "s" });
      incidents.push(...s.incidents);
    });
    expect(incidents.some((i) => i.nodeId === "s" && i.text.includes("down"))).toBe(true);
  });
});

describe("load balancer", () => {
  const graph = (strategy: string, healthChecks = false) => ({
    nodes: [
      node("c", "client", { rps: 200 }),
      node("lb", "loadBalancer", { strategy, healthChecks } as never),
      node("s1", "server", { workers: 4, serviceMs: 40 }),
      node("s2", "server", { workers: 4, serviceMs: 40 }),
      node("s3", "server", { workers: 4, serviceMs: 100 }),
    ],
    edges: [edge("c", "lb"), edge("lb", "s1"), edge("lb", "s2"), edge("lb", "s3")],
  });

  it("round robin overloads the slow server; least connections does not", () => {
    const rr = run(graph("roundRobin"), 15000).snap;
    const lc = run(graph("leastConnections"), 15000).snap;
    expect(rr.nodes.s3.errorsPerSec).toBeGreaterThan(5);
    expect(lc.nodes.c.errorRate).toBeLessThan(0.01);
  });

  it("without health checks a crashed server keeps getting traffic", () => {
    const check = (hc: boolean) => {
      const sim = new Simulation(graph("roundRobin", hc), 3);
      sim.runUntil(2000);
      sim.applyFault({ type: "crash", nodeId: "s1" });
      let snap = sim.snapshot();
      for (let t = 2100; t <= 6000; t += 100) {
        sim.runUntil(t);
        snap = sim.snapshot();
      }
      return snap.nodes.c.errorRate;
    };
    expect(check(false)).toBeGreaterThan(0.25);
    expect(check(true)).toBeLessThan(check(false));
  });
});

describe("cache", () => {
  const graph = (withCache: boolean, ttlMs = 30000) => ({
    nodes: [
      node("c", "client", { rps: 400, keySpace: 10000, hotShare: 0.8 }),
      node("s", "server", { workers: 32, serviceMs: 5, queueLimit: 200 }),
      ...(withCache ? [node("k", "cache", { capacity: 2000, ttlMs })] : []),
      node("db", "database", { workers: 8, serviceMs: 25, queueLimit: 200 }),
    ],
    edges: withCache ? [edge("c", "s"), edge("s", "k"), edge("k", "db")] : [edge("c", "s"), edge("s", "db")],
  });

  it("without a cache the database is the bottleneck", () => {
    const { snap } = run(graph(false), 10000);
    expect(snap.nodes.db.bottleneck).toBe(true);
    expect(snap.nodes.c.errorRate).toBeGreaterThan(0.05);
  });

  it("a cache absorbs the hot keys and the errors go away", () => {
    const { snap } = run(graph(true), 15000);
    expect(snap.nodes.k.hitRatio).toBeGreaterThan(0.6);
    expect(snap.nodes.c.errorRate).toBeLessThan(0.01);
  });
});
