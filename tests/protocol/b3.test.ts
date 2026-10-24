import { describe, expect, it } from "vitest";
import { compileUserCode } from "@/engine/protocol/compile";
import { simulate } from "@/engine/protocol/check";
import { Runtime } from "@/engine/protocol/world";
import { B3, B3_STARTER } from "@/content/protocols/b3";
import { B3_NO_SYNC, B3_SOLUTION } from "./solutions";

function runtime(src: string, crashes = B3.budget.crashes) {
  const c = compileUserCode(src);
  if (!c.exports) throw new Error(c.error ?? "no exports");
  return new Runtime({ ...B3, budget: { ...B3.budget, crashes } }, B3.roles(c.exports));
}
const LOSSY = { runs: 40, maxSteps: 3000, healSteps: 6000, seed: 3, crashChance: 0, restartAfter: 150 };
const CRASHY = { ...LOSSY, runs: 60, crashChance: 0.004 };

describe("B3 primary-backup", () => {
  it("the reference survives a lossy network", () => {
    const r = simulate(runtime(B3_SOLUTION), LOSSY);
    expect(r.failure).toBeNull();
  });
  it("the reference survives crashes and restarts", () => {
    const r = simulate(runtime(B3_SOLUTION), CRASHY);
    expect(r.failure).toBeNull();
  });
  it("the starter fails (duplicates applied twice)", () => {
    const r = simulate(runtime(B3_STARTER), LOSSY);
    expect(r.ok).toBe(false);
  });
  it("skipping state transfer passes without crashes but fails with them", () => {
    expect(simulate(runtime(B3_NO_SYNC), LOSSY).failure).toBeNull();
    const r = simulate(runtime(B3_NO_SYNC), CRASHY);
    expect(r.ok).toBe(false);
    expect(r.failure!.message).toMatch(/missing/);
    expect(r.failure!.steps.some((s) => s.type === "crash")).toBe(true);
  });
});
