import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, FaultAction, Graph, GraphNode } from "@/engine/model/types";
import { GoalTracker, type Preset } from "@/lib/goals";
import { A1, A2, A3 } from "@/content/system-design/presets";
import { A4, A5, A6, A7, A8 } from "@/content/system-design/presets2";

/**
 * Plays a lesson the way a learner would: the graph can be edited (which
 * restarts the simulation, like the app), configs tweaked live, faults applied.
 */
type Step =
  | { at: number; config: string; patch: Record<string, unknown> }
  | { at: number; fault: FaultAction }
  | { at: number; graph: (g: Graph) => Graph };

function play(preset: Preset, start: Graph, steps: Step[], ms: number) {
  let graph = structuredClone(start);
  const sim = new Simulation(graph, 5);
  const tracker = new GoalTracker(preset.goals);
  let elapsed = 0;
  const pending = [...steps].sort((a, b) => a.at - b.at);
  while (elapsed < ms) {
    elapsed += 100;
    sim.runUntil(sim.now + 100);
    while (pending.length && pending[0].at <= elapsed) {
      const s = pending.shift()!;
      if ("config" in s) {
        graph = {
          ...graph,
          nodes: graph.nodes.map((nd) => (nd.id === s.config ? { ...nd, config: { ...nd.config, ...s.patch } as AnyConfig } : nd)),
        };
        sim.updateConfig(s.config, graph.nodes.find((nd) => nd.id === s.config)!.config);
      } else if ("fault" in s) sim.applyFault(s.fault);
      else {
        graph = s.graph(graph);
        sim.applyGraph(graph); // edits apply live, like in the app
      }
    }
    tracker.update(sim.snapshot(), graph);
  }
  return tracker.done;
}

const nd = (id: string, kind: ComponentKind, x: number, y: number, config: Partial<AnyConfig> = {}): GraphNode => ({
  id,
  kind,
  label: id,
  position: { x, y },
  config: { ...defaultConfig(kind), ...config } as AnyConfig,
});
const ed = (s: string, t: string) => ({ id: `e-${s}-${t}`, source: s, target: t });
const addNodes = (g: Graph, nodes: GraphNode[], edges: { id: string; source: string; target: string }[], drop: string[] = []): Graph => ({
  nodes: [...g.nodes, ...nodes],
  edges: [...g.edges.filter((x) => !drop.includes(x.id)), ...edges],
});

const allGoals = (p: Preset) => p.goals.map((g) => g.id).sort();

describe("every lesson goal can be completed", () => {
  it("A1", () => {
    const done = play(A1, A1.graph, [
      { at: 1000, config: "users", patch: { rps: 90 } },
      { at: 8000, config: "users", patch: { rps: 160 } },
      { at: 20000, config: "api", patch: { workers: 10 } },
      { at: 20000, config: "users", patch: { rps: 180 } },
    ], 30000);
    expect([...done].sort()).toEqual(allGoals(A1));
  });

  it("A2", () => {
    const done = play(A2, A2.graph, [
      { at: 1000, config: "lb", patch: { strategy: "leastConnections" } },
      { at: 8000, fault: { type: "crash", nodeId: "s1" } },
      { at: 12000, graph: (g) => addNodes(g, [nd("s4", "server", 560, 450)], [ed("lb", "s4")]) },
      { at: 12100, config: "lb", patch: { healthChecks: true } },
      { at: 13000, fault: { type: "crash", nodeId: "s1" } },
    ], 22000);
    expect([...done].sort()).toEqual(allGoals(A2));
  });

  it("A3", () => {
    const done = play(A3, A3.graph, [
      { at: 5000, graph: (g) => addNodes(g, [nd("k", "cache", 550, 40, { capacity: 2000 })], [ed("api", "k"), ed("k", "db")], ["e-api-db"]) },
      { at: 12000, fault: { type: "crash", nodeId: "k" } },
      { at: 13000, fault: { type: "recover", nodeId: "k" } },
    ], 20000);
    expect([...done].sort()).toEqual(allGoals(A3));
  });

  it("A4", () => {
    const withReplicas = addNodes(
      A4.graph,
      [nd("r1", "replica", 880, 0), nd("r2", "replica", 880, 220)],
      [ed("api", "r1"), ed("api", "r2"), ed("primary", "r1"), ed("primary", "r2")],
    );
    const done = play(A4, withReplicas, [
      { at: 8000, config: "users", patch: { writeShare: 0.4 } },
      { at: 20000, config: "users", patch: { writeShare: 0.1 } },
      { at: 30000, fault: { type: "crash", nodeId: "primary" } },
    ], 36000);
    expect([...done].sort()).toEqual(allGoals(A4));
  });

  it("A5", () => {
    const four = addNodes(A5.graph, [nd("s3", "database", 800, 420), nd("s4", "database", 800, 620)], [ed("router", "s3"), ed("router", "s4")]);
    const done = play(A5, four, [
      { at: 7000, config: "users", patch: { topKeyShare: 0.3 } },
      { at: 12000, graph: (g) => addNodes(g, [nd("k", "cache", 400, 300, { capacity: 2000 })], [ed("api", "k"), ed("k", "router")], ["e-api-router"]) },
    ], 22000);
    expect([...done].sort()).toEqual(allGoals(A5));
  });

  it("A6", () => {
    const workers = (count: number) =>
      Array.from({ length: count }, (_, i) => nd(`w${i}`, "server", 820, i * 140, { workers: 8, serviceMs: 200 }));
    const async = (count: number) => (g: Graph): Graph => {
      const base: Graph = {
        nodes: g.nodes.filter((x) => !x.id.startsWith("w")).map((x) => (x.id === "api" ? { ...x, config: { ...x.config, serviceMs: 5 } as AnyConfig } : x)),
        edges: g.edges.filter((x) => !x.target.startsWith("w")),
      };
      const hasQueue = base.nodes.some((x) => x.id === "q");
      return addNodes(
        base,
        [...(hasQueue ? [] : [nd("q", "queue", 560, 60)]), ...workers(count)],
        [...(hasQueue ? [] : [ed("api", "q")]), ...workers(count).map((w) => ed("q", w.id))],
      );
    };
    const done = play(A6, A6.graph, [
      { at: 1000, graph: async(3) },
      { at: 9000, graph: async(5) },
      { at: 9100, config: "users", patch: { pattern: "spike" } },
      { at: 30000, config: "users", patch: { pattern: "steady" } },
      ...[0, 1, 2, 3, 4].map((i) => ({ at: 32000, fault: { type: "crash" as const, nodeId: `w${i}` } })),
      ...[0, 1, 2, 3, 4].map((i) => ({ at: 38000, fault: { type: "recover" as const, nodeId: `w${i}` } })),
    ], 60000);
    expect([...done].sort()).toEqual(allGoals(A6));
  });

  it("A7", () => {
    const done = play(A7, A7.graph, [
      { at: 3000, config: "db", patch: { serviceMs: 50 } },
      { at: 10000, config: "api", patch: { queueLimit: 20 } },
      { at: 18000, config: "users", patch: { retryBudget: 0.1 } },
      { at: 26000, fault: { type: "cut", edgeIds: ["e-api-db"] } },
      { at: 27000, config: "api", patch: { timeoutMs: 300, breaker: true } },
    ], 36000);
    expect([...done].sort()).toEqual(allGoals(A7));
  });

  it("A8", () => {
    const link = ["e-euDb-usDb", "e-usDb-euDb"];
    const done = play(A8, A8.graph, [
      { at: 3000, fault: { type: "cut", edgeIds: link } },
      { at: 9000, fault: { type: "heal", edgeIds: link } },
      { at: 14000, config: "euDb", patch: { mode: "sync" } },
      { at: 14000, config: "usDb", patch: { mode: "sync" } },
      { at: 17000, fault: { type: "cut", edgeIds: link } },
    ], 24000);
    expect([...done].sort()).toEqual(allGoals(A8));
  });
});
