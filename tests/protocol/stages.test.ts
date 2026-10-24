import { describe, expect, it } from "vitest";
import { LABS } from "@/content/protocols";
import { runStage } from "@/engine/protocol/stages";
import { B1_SOLUTION, B2_SOLUTION, B3_SOLUTION, B4_SOLUTION } from "./solutions";

const SOLUTIONS: Record<string, string> = {
  "b1-clocks": B1_SOLUTION,
  "b2-rpc": B2_SOLUTION,
  "b3-primary-backup": B3_SOLUTION,
  "b4-paxos": B4_SOLUTION,
};

describe("lab stages, as the workbench runs them", () => {
  for (const lab of LABS) {
    it(`${lab.slug}: the reference passes every stage`, () => {
      for (const stage of lab.stages) {
        const r = runStage(lab.id, SOLUTIONS[lab.slug], stage.id);
        expect(r.failure, `${lab.slug}/${stage.id}: ${r.failure?.message}`).toBeNull();
      }
    }, 180000);
    it(`${lab.slug}: the starter fails some stage`, () => {
      const failed = lab.stages.some((s) => !runStage(lab.id, lab.starter, s.id).ok);
      expect(failed).toBe(true);
    }, 180000);
  }
});
