import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { Simulation } from "@/engine/model/simulation";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, GraphNode, Region } from "@/engine/model/types";
import { GoalTracker } from "@/lib/goals";
import { monthlyCost } from "@/lib/cost";
import { C1, C2, C3, C4, type Challenge } from "@/content/challenges";

const nd = (id: string, kind: ComponentKind, config: Partial<AnyConfig> = {}, region?: Region): GraphNode => ({
  id,
  kind,
  label: id,
  position: { x: 0, y: 0 },
  config: { ...defaultConfig(kind), ...config } as AnyConfig,
  ...(region ? { region } : {}),
});
const ed = (s: string, t: string) => ({ id: `${s}>${t}`, source: s, target: t });

/** Run a reference design, crash one component part-way, and report what passed. */
function attempt(ch: Challenge, design: Graph, crash: string, ms = 60000) {
  const graph: Graph = { nodes: [...ch.graph.nodes, ...design.nodes], edges: design.edges };
  const sim = new Simulation(graph, 11);
  const tracker = new GoalTracker(ch.goals);
  let maxCost = 0;
  const unmet = new Map<string, number>();
  for (let t = 100; t <= ms; t += 100) {
    sim.runUntil(t);
    if (t === ms - 15000) sim.applyFault({ type: "crash", nodeId: crash });
    const snap = sim.snapshot();
    tracker.update(snap, graph);
    maxCost = Math.max(maxCost, monthlyCost(graph, snap).total);
    if (t > 15000 && t < ms - 15000) for (const r of ch.requirements) if (!r.check(snap, graph)) unmet.set(r.id, (unmet.get(r.id) ?? 0) + 1);
  }
  return { done: [...tracker.done].sort(), maxCost, unmet: Object.fromEntries(unmet) };
}

const report: string[] = [];

describe("every challenge has a passing design within budget", () => {
  it("C1 URL shortener", () => {
    const servers = ["s1", "s2", "s3"];
    const design: Graph = {
      nodes: [
        nd("lb", "loadBalancer", { strategy: "leastConnections", healthChecks: true }),
        ...servers.map((s) => nd(s, "server", { workers: 16, serviceMs: 5, queueLimit: 200 })),
        nd("cache", "cache", { capacity: 30000, ttlMs: 600000 }),
        nd("db", "database", { workers: 12, serviceMs: 25 }),
      ],
      edges: [ed("users", "lb"), ...servers.map((s) => ed("lb", s)), ...servers.map((s) => ed(s, "cache")), ed("cache", "db")],
    };
    const r = attempt(C1, design, "s2", 90000);
    report.push(`C1 ${JSON.stringify(r)}`);
    expect(r.done).toEqual(["pass", "resilient"]);
  });

  it("C2 photo uploads", () => {
    const workers = ["w1", "w2", "w3"];
    const design: Graph = {
      nodes: [nd("api", "server", { workers: 16, serviceMs: 5 }), nd("q", "queue", { capacity: 20000 }), ...workers.map((w) => nd(w, "server", { workers: 40, serviceMs: 300 }))],
      edges: [ed("users", "api"), ed("api", "q"), ...workers.map((w) => ed("q", w))],
    };
    const r = attempt(C2, design, "w2", 70000);
    report.push(`C2 ${JSON.stringify(r)}`);
    expect(r.done).toEqual(["pass", "resilient"]);
  });

  it("C3 flash sale", () => {
    const servers = ["s1", "s2", "s3"];
    const design: Graph = {
      nodes: [
        nd("lb", "loadBalancer", { strategy: "leastConnections", healthChecks: true, rateLimit: 900, rateLimitScope: "perClient" }),
        ...servers.map((s) => nd(s, "server", { workers: 24, serviceMs: 30, queueLimit: 300 })),
      ],
      edges: [ed("users", "lb"), ed("bot", "lb"), ...servers.map((s) => ed("lb", s))],
    };
    const r = attempt(C3, design, "s2", 70000);
    report.push(`C3 ${JSON.stringify(r)}`);
    expect(r.done).toEqual(["pass", "resilient"]);
  });

  it("C4 global profiles", () => {
    const design: Graph = {
      nodes: [
        nd("cdnM", "cache", { capacity: 5000, ttlMs: 60000 }, "mumbai"),
        nd("cdnV", "cache", { capacity: 5000, ttlMs: 60000 }, "virginia"),
        nd("lb", "loadBalancer", { strategy: "leastConnections", healthChecks: true }, "virginia"),
        nd("api1", "server", { workers: 16, serviceMs: 5 }, "virginia"),
        nd("api2", "server", { workers: 16, serviceMs: 5 }, "virginia"),
        nd("db", "database", { workers: 8, serviceMs: 20 }, "virginia"),
      ],
      edges: [
        ed("mumbaiUsers", "cdnM"),
        ed("virginiaUsers", "cdnV"),
        ed("cdnM", "lb"),
        ed("cdnV", "lb"),
        ed("lb", "api1"),
        ed("lb", "api2"),
        ed("api1", "db"),
        ed("api2", "db"),
      ],
    };
    const r = attempt(C4, design, "api1");
    report.push(`C4 ${JSON.stringify(r)}`);
    writeFileSync("/tmp/claude-0/-home-claude/b637f449-2a12-5f3e-8818-73623c71e2e9/scratchpad/challenges.txt", report.join("\n"));
    expect(r.done).toEqual(["pass", "resilient"]);
  });
});
