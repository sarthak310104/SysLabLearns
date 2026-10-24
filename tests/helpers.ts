import { Simulation } from "@/engine/model/simulation";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, GraphNode, Snapshot } from "@/engine/model/types";

export function node(id: string, kind: ComponentKind, config: Partial<AnyConfig> = {}): GraphNode {
  return {
    id,
    kind,
    label: id,
    config: { ...defaultConfig(kind), ...config } as AnyConfig,
    position: { x: 0, y: 0 },
  };
}

export function edge(source: string, target: string) {
  return { id: `${source}->${target}`, source, target };
}

/** Run a simulation for `ms`, taking a snapshot every 100ms like the UI does; returns the last one. */
export function run(graph: Graph, ms: number, seed = 7, onTick?: (sim: Simulation, s: Snapshot) => void) {
  const sim = new Simulation(graph, seed);
  let snap: Snapshot = sim.snapshot();
  for (let t = 100; t <= ms; t += 100) {
    sim.runUntil(t);
    snap = sim.snapshot();
    onTick?.(sim, snap);
  }
  return { sim, snap };
}
