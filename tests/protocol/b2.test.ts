import { describe, expect, it } from "vitest";
import { compileUserCode } from "@/engine/protocol/compile";
import { modelCheck, replay, simulate } from "@/engine/protocol/check";
import { Runtime } from "@/engine/protocol/world";
import { B2, B2_STARTER } from "@/content/protocols/b2";
import { B2_NO_DEDUP, B2_SHARED_DEDUP, B2_SOLUTION } from "./solutions";

function runtime(src: string) {
  const c = compileUserCode(src);
  if (!c.exports) throw new Error(c.error ?? "no exports");
  return new Runtime(B2, B2.roles(c.exports));
}
const SIM = { runs: 100, maxSteps: 400, healSteps: 2000, seed: 1, crashChance: 0, restartAfter: 50 };

describe("protocol engine on B2 (exactly-once RPC)", () => {
  it("the starter works on a perfect network", () => {
    const rt = runtime(B2_STARTER);
    let w = rt.init("timed", 1);
    // No faults: deliver everything in time order.
    const perfect = new Runtime({ ...B2, network: { ...B2.network, drop: 0, duplicate: 0 } }, B2.roles(compileUserCode(B2_STARTER).exports!));
    w = perfect.init("timed", 1);
    for (let i = 0; i < 200 && !perfect.done(w); i++) w = perfect.apply(w, perfect.nextTimed(w)!);
    expect(perfect.done(w)).toBe(true);
    expect(perfect.violation(w)).toBeNull();
    expect(rt).toBeDefined();
  });

  it("the starter fails random simulation on a lossy network", () => {
    const r = simulate(runtime(B2_STARTER), SIM);
    expect(r.ok).toBe(false);
  });

  it("the model checker finds the starter's bug, with a short trace that replays", () => {
    const rt = runtime(B2_STARTER);
    const r = modelCheck(rt);
    expect(r.ok).toBe(false);
    expect(r.failure!.steps.length).toBeLessThan(8);
    const frames = replay(rt, r.failure!);
    expect(rt.violation(frames[frames.length - 1].world)).not.toBeNull();
  });

  it("the reference solution passes simulation and the model checker", () => {
    const rt = runtime(B2_SOLUTION);
    expect(simulate(rt, SIM).failure).toBeNull();
    const mc = modelCheck(rt, { timeLimitMs: 60000 });
    expect(mc.failure).toBeNull();
    expect(mc.reachedDone).toBe(true);
    expect(mc.depth).toBe(B2.budget.maxDepth);
  }, 90000);

  it("catches a server without duplicate detection", () => {
    const r = modelCheck(runtime(B2_NO_DEDUP));
    expect(r.ok).toBe(false);
    expect(r.failure!.message).toContain("more than once");
  });

  it("catches duplicate detection shared between clients", () => {
    const sim = simulate(runtime(B2_SHARED_DEDUP), SIM);
    const mc = modelCheck(runtime(B2_SHARED_DEDUP));
    expect(sim.ok && mc.ok).toBe(false);
  });

  it("blocks non-deterministic APIs with a helpful message", () => {
    const c = compileUserCode(`export const client = { init(){ return { r: Math.random() }; } }; export const server = {};`);
    const rt = new Runtime(B2, B2.roles(c.exports!));
    const w = rt.init("timed", 1);
    expect(rt.violation(w)?.message).toContain("ctx.random()");
  });
});
