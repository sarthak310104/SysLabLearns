import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import type { Graph } from "@/engine/model/types";
import { edge, node } from "./helpers";

function runFor(sim: Simulation, ms: number) {
  let snap = sim.snapshot();
  const end = sim.now + ms;
  while (sim.now < end) {
    sim.runUntil(sim.now + 100);
    snap = sim.snapshot();
  }
  return snap;
}

describe("live graph edits", () => {
  const base: Graph = {
    nodes: [node("c", "client", { rps: 180 }), node("lb", "loadBalancer"), node("s1", "server"), node("db", "database")],
    edges: [edge("c", "lb"), edge("lb", "s1")],
  };

  it("adding a server mid-run relieves the overload without restarting", () => {
    const sim = new Simulation(base, 3);
    const before = runFor(sim, 8000);
    expect(before.nodes.c.errorRate).toBeGreaterThan(0.2);
    sim.applyGraph({ nodes: [...base.nodes, node("s2", "server")], edges: [...base.edges, edge("lb", "s2")] });
    const after = runFor(sim, 8000);
    expect(after.time).toBeGreaterThan(15000); // time kept going
    expect(after.nodes.c.errorRate).toBeLessThan(0.01);
    expect(after.nodes.s2.okPerSec).toBeGreaterThan(50);
  });

  it("removing a component fails what it held, and nothing hangs", () => {
    const g: Graph = { nodes: [...base.nodes, node("s2", "server")], edges: [...base.edges, edge("lb", "s2")] };
    const sim = new Simulation(g, 3);
    runFor(sim, 4000);
    sim.applyGraph({ nodes: g.nodes.filter((n) => n.id !== "s2"), edges: g.edges.filter((e) => e.target !== "s2") });
    const snap = runFor(sim, 3000);
    expect(snap.nodes.s2).toBeUndefined();
    expect(snap.nodes.s1.okPerSec).toBeGreaterThan(50);
  });

  it("existing state survives an edit: a warm cache stays warm", () => {
    const g: Graph = {
      nodes: [node("c", "client", { rps: 300, hotShare: 0.9 }), node("s", "server", { workers: 32, serviceMs: 2 }), node("k", "cache", { capacity: 2000 }), node("db", "database")],
      edges: [edge("c", "s"), edge("s", "k"), edge("k", "db")],
    };
    const sim = new Simulation(g, 3);
    const warm = runFor(sim, 8000).nodes.k.hitRatio!;
    sim.applyGraph({ ...g, nodes: [...g.nodes, node("extra", "server")] });
    const after = runFor(sim, 300).nodes.k.hitRatio!;
    expect(after).toBeGreaterThan(warm - 0.1);
  });
});
