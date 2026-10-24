import { describe, expect, it } from "vitest";
import { compileUserCode } from "@/engine/protocol/compile";
import { modelCheck, simulate } from "@/engine/protocol/check";
import type { ProtocolSpec } from "@/engine/protocol/types";
import { Runtime } from "@/engine/protocol/world";
import { B1, B1_STARTER } from "@/content/protocols/b1";
import { B4, B4_STARTER } from "@/content/protocols/b4";
import { B1_SOLUTION, B1_VECTOR_NO_TICK, B4_COUNTS_DUPLICATES, B4_IGNORES_ACCEPTED, B4_SOLUTION } from "./solutions";

const rt = (spec: ProtocolSpec, src: string) => {
  const c = compileUserCode(src);
  if (!c.exports) throw new Error(c.error ?? "");
  return new Runtime(spec, spec.roles(c.exports));
};
const SIM = { runs: 100, maxSteps: 600, healSteps: 3000, seed: 3, crashChance: 0, restartAfter: 50 };

describe("B1 clocks", () => {
  it("the starter's Lamport clocks break causality", () => {
    const r = rt(B1, B1_STARTER);
    r.only = ["Lamport clocks respect causality"];
    expect(simulate(r, SIM).failure?.name).toBe("Lamport clocks respect causality");
  });
  it("a vector clock that forgets to tick on receive is caught", () => {
    const r = simulate(rt(B1, B1_VECTOR_NO_TICK), SIM);
    expect(r.failure?.name).toBe("Vector clocks capture causality exactly");
  });
  it("the reference solution passes", () => {
    expect(simulate(rt(B1, B1_SOLUTION), SIM).failure).toBeNull();
  });
});

describe("B4 Paxos", () => {
  it("the model checker finds two values chosen in the starter, quickly", () => {
    const r = modelCheck(rt(B4, B4_STARTER), { timeLimitMs: 20000 });
    expect(r.failure?.name).toBe("Agreement: only one value is ever chosen");
    expect(r.failure!.steps.length).toBeLessThanOrEqual(14);
  }, 30000);
  it("catches a proposer that ignores previously accepted values", () => {
    const r = modelCheck(rt(B4, B4_IGNORES_ACCEPTED), { timeLimitMs: 60000 });
    expect(r.failure?.name).toMatch(/Agreement/);
  }, 90000);
  it("catches a proposer that counts a repeated acceptance twice", () => {
    const r = rt(B4, B4_COUNTS_DUPLICATES);
    const sim = simulate(r, { ...SIM, runs: 300 });
    const mc = sim.ok ? modelCheck(r, { timeLimitMs: 30000 }) : null;
    expect(sim.ok && mc?.ok).toBe(false);
  }, 90000);
  it("the reference solution passes the model checker and random simulation", () => {
    const r = rt(B4, B4_SOLUTION);
    const mc = modelCheck(r, { timeLimitMs: 20000 });
    expect(mc.failure).toBeNull();
    expect(mc.depth).toBeGreaterThanOrEqual(12);
    expect(simulate(r, SIM).failure).toBeNull();
  }, 60000);
});
