import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import type { Graph } from "@/engine/model/types";
import { monthlyCost } from "@/lib/cost";
import { FOLLOW_UP_PASS, INTERVIEWS, followUpMs, followUpScenario, type Interview } from "@/content/interviews";

/** Run the suggested design: requirements in steady state, then the follow-up event. */
function run(iv: Interview) {
  const graph: Graph = { nodes: [...iv.graph.nodes, ...iv.suggested.design.nodes], edges: iv.suggested.design.edges };
  const sim = new Simulation(graph, 7);
  const unmet: Record<string, number> = {};
  let checks = 0;
  for (let t = 100; t <= 40000; t += 100) {
    sim.runUntil(t);
    if (t < 15000) continue;
    checks++;
    const s = sim.snapshot();
    for (const r of iv.requirements) if (!r.check(s, graph)) unmet[r.id] = (unmet[r.id] ?? 0) + 1;
  }
  const sc = followUpScenario(iv, graph);
  sim.applyFault({ type: "scenario", name: sc.name, steps: sc.steps });
  let broke = 0;
  let during = 0;
  const end = 40000 + followUpMs(sc);
  for (let t = 40100; t <= end; t += 100) {
    sim.runUntil(t);
    during++;
    if (!iv.followUp.holds.check(sim.snapshot(), graph)) broke++;
  }
  return { unmet, checks, broke, during, cost: monthlyCost(graph).total, steps: sc.steps.length };
}

describe("interview prompts", () => {
  for (const iv of INTERVIEWS) {
    it(`${iv.slug}: the suggested design meets every requirement and survives the follow-up`, () => {
      const r = run(iv);
      expect(r.cost, "cost").toBeLessThanOrEqual(iv.budget);
      expect(r.unmet, JSON.stringify(r)).toEqual({});
      expect(r.steps).toBeGreaterThan(0);
      expect(1 - r.broke / r.during, JSON.stringify(r)).toBeGreaterThanOrEqual(FOLLOW_UP_PASS + 0.03);
    }, 60000);

    it(`${iv.slug}: every requirement is revealed by a question, and estimates have working`, () => {
      const ids = new Set(iv.questions.map((q) => q.id));
      for (const r of iv.requirements) expect(ids.has(r.revealedBy)).toBe(true);
      for (const e of iv.estimates) expect(e.working.length).toBeGreaterThan(20);
    });
  }
});

import { scoreInterview } from "@/lib/interviewScore";
import { I1 } from "@/content/interviews";

describe("interview scorecard", () => {
  const perfect = {
    asked: I1.questions.filter((q) => q.key).map((q) => q.id),
    estimates: Object.fromEntries(I1.estimates.map((e) => [e.id, e.answer])),
    bestHoldMs: 20000,
    metAtEnd: Object.fromEntries(I1.requirements.map((r) => [r.id, true])),
    followUp: { ran: true, checks: 100, held: 95 },
    elapsedMs: 20 * 60000,
  };
  it("a perfect run scores 100 and a strong hire", () => {
    const s = scoreInterview(I1, perfect);
    expect(s.total).toBe(100);
    expect(s.grade).toBe("Strong hire");
  });
  it("skipping questions, a wrong estimate and no follow-up cost points", () => {
    const s = scoreInterview(I1, { ...perfect, asked: ["traffic"], estimates: { "db-reads": 100 }, followUp: { ran: false, checks: 0, held: 0 } });
    expect(s.lines.find((l) => l.id === "clarify")!.points).toBeLessThan(5);
    expect(s.lines.find((l) => l.id === "estimate")!.points).toBe(0);
    expect(s.lines.find((l) => l.id === "followup")!.points).toBe(0);
    expect(s.total).toBeLessThan(50);
  });
  it("accepts estimates within tolerance", () => {
    const s = scoreInterview(I1, { ...perfect, estimates: { "db-reads": 2800, connections: 80 } });
    expect(s.lines.find((l) => l.id === "estimate")!.points).toBe(20);
  });
  it("loses time points when over", () => {
    const s = scoreInterview(I1, { ...perfect, elapsedMs: (I1.minutes + 3) * 60000 });
    expect(s.lines.find((l) => l.id === "time")!.points).toBe(4);
  });
});
