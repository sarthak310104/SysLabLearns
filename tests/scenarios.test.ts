import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import { A2 } from "@/content/system-design/presets";
import { scenariosFor } from "@/lib/scenarios";

const ok = (sim: Simulation) => {
  const s = sim.snapshot();
  return Object.values(s.nodes).filter((n) => n.kind === "client").reduce((a, c) => a + (c.sendingRps ?? 0), 0);
};

describe("scenario events", () => {
  it("a traffic spike multiplies load for 20 s, then ends", () => {
    const sim = new Simulation(structuredClone(A2.graph), 3);
    sim.runUntil(5000);
    const base = ok(sim);
    const spike = scenariosFor(A2.graph).find((x) => x.id === "spike")!;
    sim.applyFault({ type: "scenario", name: spike.name, steps: spike.steps });
    sim.runUntil(15000);
    const snap = sim.snapshot();
    expect(snap.loadFactor).toBe(5);
    expect(snap.scenario?.name).toBe("Traffic spike");
    expect(ok(sim)).toBeGreaterThan(base * 3);
    sim.runUntil(30000);
    expect(sim.snapshot().loadFactor).toBe(1);
    expect(sim.snapshot().scenario).toBeNull();
  });

  it("only offers what the design has", () => {
    const sc = scenariosFor(A2.graph);
    expect(sc.find((x) => x.id === "db-slow")!.unavailable).toBeTruthy();
    expect(sc.find((x) => x.id === "server-crash")!.unavailable).toBeUndefined();
    expect(sc.find((x) => x.id === "region-outage")!.unavailable).toBeTruthy();
  });
});
