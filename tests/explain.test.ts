import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import { A1 } from "@/content/system-design/presets";
import { A7 as A7b } from "@/content/system-design/presets2";
import { explainNode, explainSystem } from "@/lib/explain";


describe("explain this", () => {
  it("explains an overloaded server with real numbers", () => {
    const g = structuredClone(A1.graph);
    g.nodes[0].config = { ...g.nodes[0].config, rps: 160 } as typeof g.nodes[0]["config"];
    const sim = new Simulation(g, 2);
    sim.runUntil(12000);
    const snap = sim.snapshot();
    const server = explainNode(g, snap, "api").join(" ");
    expect(server).toMatch(/4 workers/);
    expect(server).toMatch(/room for about 100 requests a second/);
    expect(server).toMatch(/turned away/);
    expect(explainSystem(g, snap).join(" ")).toMatch(/bottleneck/);
  });

  it("spots a server that's only waiting on something slower", () => {
    const g = structuredClone(A7b.graph);
    const db = g.nodes.find((n) => n.kind === "database")!;
    const sim = new Simulation(g, 2);
    sim.runUntil(3000);
    sim.applyFault({ type: "slow", nodeId: db.id, factor: 4 });
    sim.runUntil(15000);
    const snap = sim.snapshot();
    const api = g.nodes.find((n) => n.kind === "server")!;
    expect(explainNode(g, snap, api.id).join(" ")).toMatch(/waiting on|turned away/);
    expect(explainNode(g, snap, db.id).join(" ")).toMatch(/slowed 4x/);
  });
});
